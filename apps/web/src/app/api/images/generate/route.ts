import { randomUUID } from "node:crypto";
import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { imageModelIdSchema } from "@repo/shared/image-generation/model-contract";
import { OperationError } from "@repo/shared/uol";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toClientErrorMessage } from "@/features/image-generation/error-sanitize";
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
import { invokeImageEnqueueAsyncOperation } from "@/features/image-generation/uol-client";

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

function generationErrorResponse(error: unknown) {
  if (error instanceof OperationError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      },
      { status: error.httpStatus }
    );
  }
  return errorResponse(
    toClientErrorMessage(
      error,
      { source: "image-generate-route" },
      IMAGE_GENERATION_ERROR_FALLBACK
    )
  );
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

  const role = await getUserRoleById(session.user.id);

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
  const requestedGenerationId =
    parsed.data.generationId || parsed.data.generation_id;
  const principal = {
    type: "user" as const,
    userId: session.user.id,
    role,
  };
  const requestId = request.headers.get("x-request-id") ?? undefined;
  try {
    const generationId = requestedGenerationId ?? randomUUID();
    const task = await invokeImageEnqueueAsyncOperation(
      {
        taskId: `task_${randomUUID().replace(/-/g, "")}`,
        generationInput: { ...input, generationId },
        responseFormat: "url",
      },
      principal,
      requestId
    );
    return NextResponse.json(task, { status: 202 });
  } catch (error) {
    return generationErrorResponse(error);
  }
});
