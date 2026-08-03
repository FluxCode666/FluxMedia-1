import { randomUUID } from "node:crypto";
import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { imageModelIdSchema } from "@repo/shared/image-generation/model-contract";
import {
  canUsePlanCapability,
  getPlanLimits,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  firstBatchError,
  runBatchImageGeneration,
} from "@/features/image-generation/batch-runner";
import { toClientErrorMessage } from "@/features/image-generation/error-sanitize";
import type { ImageGenerationOperationResult } from "@/features/image-generation/operations";
import {
  normalizeOutputCompression,
  normalizeOutputFormat,
} from "@/features/image-generation/output-format";
import { hasTrustedImageGenerationOrigin } from "@/features/image-generation/request-security";
import {
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
  resolveImageRequestSize,
  validateImageSize,
} from "@/features/image-generation/resolution";
import { createImageStreamResponse } from "@/features/image-generation/streaming";
import { invokeImageGenerationOperation } from "@/features/image-generation/uol-client";

const IMAGE_GENERATION_ERROR_FALLBACK =
  "Image generation failed. Please retry shortly.";

const generateImageSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
    generationId: z.string().min(1).max(128).optional(),
    generation_id: z.string().min(1).max(128).optional(),
    generationIds: z.array(z.string().min(1).max(128)).optional(),
    generation_ids: z.array(z.string().min(1).max(128)).optional(),
    apiPrompt: z.string().min(1).max(8000).optional(),
    promptOptimization: z.boolean().optional(),
    size: z
      .string()
      .optional()
      .refine((value) => !value || validateImageSize(value).valid, {
        message: "Invalid image size",
      }),
    model: imageModelIdSchema,
    backendGroupId: z.string().trim().min(1).max(128).optional(),
    backend_group_id: z.string().trim().min(1).max(128).optional(),
    thinking: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
    stream: z.boolean().optional(),
    count: z.number().int().min(1).max(10_000).optional(),
    quality: z.enum(["auto", "low", "medium", "high"]).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    transparentMatte: z.boolean().optional(),
    transparent_matte: z.boolean().optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    outputCompression: z.number().int().min(0).max(100).optional(),
    // 高清修复:上游图偏小需超分时选模型。默认(含省略)=SwinIR;显式 false=general-x4v3(快)。
    hdRepair: z.boolean().optional(),
    hd_repair: z.boolean().optional(),
    // 分块修复:切成 2×2 web 块逐块 gpt-image-2 重绘再拼接超分;逐块单独计费。默认关。
    blockRepair: z.boolean().optional(),
    block_repair: z.boolean().optional(),
    repairPrompt: z.string().max(8000).optional(),
    repair_prompt: z.string().max(8000).optional(),
  })
  .strict();

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function wantsStreamResponse(request: NextRequest, stream?: boolean) {
  if (stream) return true;
  return request.headers.get("accept")?.includes("text/event-stream") ?? false;
}

function generationErrorResponse(error: unknown) {
  return errorResponse(
    toClientErrorMessage(
      error,
      { source: "image-generate-route" },
      IMAGE_GENERATION_ERROR_FALLBACK
    )
  );
}

/** 将管线正常返回的失败结果收敛为可安全回传的接口结果。 */
function sanitizeGenerationResult(
  result: ImageGenerationOperationResult,
  source: string
) {
  if (!result.error) return result;

  return {
    ...result,
    error: toClientErrorMessage(
      result.error,
      { source, generationId: result.generationId },
      IMAGE_GENERATION_ERROR_FALLBACK
    ),
  };
}

export const POST = withApiLogging(async (request: NextRequest) => {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return errorResponse("Unauthorized", 401);
  }

  if (!hasTrustedImageGenerationOrigin(request)) {
    return errorResponse("Forbidden", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  const parsed = generateImageSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message || "Invalid request");
  }

  const plan = await getUserPlan(session.user.id);
  const role = await getUserRoleById(session.user.id);
  const planLimits = await getPlanLimits(plan.plan);
  const count = parsed.data.count || 1;
  if (
    count > 1 &&
    !(await canUsePlanCapability(plan.plan, "imageGeneration.batch"))
  ) {
    return errorResponse(
      "Batch image generation is not enabled for this plan.",
      403
    );
  }
  if (count > planLimits.maxBatchCount) {
    return errorResponse(
      `count must be between 1 and ${planLimits.maxBatchCount}.`
    );
  }

  const input = {
    operation: "generate" as const,
    prompt: parsed.data.prompt,
    apiPrompt: parsed.data.apiPrompt,
    promptOptimization: parsed.data.promptOptimization,
    size: resolveImageRequestSize(parsed.data.size),
    model: parsed.data.model,
    backendGroupId: parsed.data.backendGroupId ?? parsed.data.backend_group_id,
    thinking: parsed.data.thinking,
    quality: parsed.data.quality || "auto",
    moderation: parsed.data.moderation || "auto",
    outputFormat: normalizeOutputFormat(
      parsed.data.output_format || parsed.data.outputFormat
    ),
    background: parsed.data.background,
    transparentMatte:
      parsed.data.transparentMatte ?? parsed.data.transparent_matte,
    outputCompression: normalizeOutputCompression(
      parsed.data.output_compression ?? parsed.data.outputCompression
    ),
    hdRepair: parsed.data.hdRepair ?? parsed.data.hd_repair,
    blockRepair: parsed.data.blockRepair ?? parsed.data.block_repair,
    repairPrompt: parsed.data.repairPrompt ?? parsed.data.repair_prompt,
  };
  const requestedGenerationIds =
    parsed.data.generationIds || parsed.data.generation_ids;
  const requestedGenerationId =
    parsed.data.generationId ||
    parsed.data.generation_id ||
    requestedGenerationIds?.[0];
  const batchGenerationIds =
    requestedGenerationIds?.length === count
      ? requestedGenerationIds
      : count === 1 && requestedGenerationId
        ? [requestedGenerationId]
        : undefined;
  const principal = {
    type: "user" as const,
    userId: session.user.id,
    role,
  };
  const requestId = request.headers.get("x-request-id") ?? undefined;
  const runGeneration = (
    generationId: string,
    callbacks?: Parameters<typeof invokeImageGenerationOperation>[2]
  ) =>
    invokeImageGenerationOperation(
      { ...input, generationId },
      principal,
      callbacks,
      requestId
    );

  try {
    const useStreamResponse = wantsStreamResponse(request, parsed.data.stream);

    if (useStreamResponse) {
      return createImageStreamResponse(
        async (emit) => {
          await runBatchImageGeneration({
            count,
            concurrency: planLimits.imageGenerationConcurrency,
            generationIds: batchGenerationIds,
            run: runGeneration,
            callbacks: (index) => ({
              onPartialImage: async (image) => {
                await emit({
                  type: "partial_image",
                  index,
                  partial_image_index: image.partialImageIndex,
                  b64_json: image.imageBase64,
                  url: image.imageUrl,
                });
              },
            }),
            onResult: async (result) => {
              const safeResult = sanitizeGenerationResult(
                result,
                "image-generate-stream-result"
              );
              if (safeResult.error) {
                await emit({
                  type: "error",
                  error: safeResult.error,
                  generationId: safeResult.generationId,
                  creditsConsumed: safeResult.creditsConsumed,
                });
                return;
              }
              await emit({ type: "completed", ...safeResult });
            },
            stopOnError: true,
          });

          return null;
        },
        {
          formatError: (error) =>
            toClientErrorMessage(
              error,
              { source: "image-generate-stream" },
              IMAGE_GENERATION_ERROR_FALLBACK
            ),
        }
      );
    }

    if (count === 1) {
      const result = sanitizeGenerationResult(
        await runGeneration(requestedGenerationId ?? randomUUID()),
        "image-generate-response"
      );
      return NextResponse.json(result);
    }

    const results = await runBatchImageGeneration({
      count,
      concurrency: planLimits.imageGenerationConcurrency,
      generationIds: batchGenerationIds,
      run: (generationId) => runGeneration(generationId),
    });

    const safeResults = results.map((result) =>
      sanitizeGenerationResult(result, "image-generate-batch-response")
    );

    return NextResponse.json({
      results: safeResults,
      error: firstBatchError(safeResults)?.error,
    });
  } catch (error) {
    return generationErrorResponse(error);
  }
});
