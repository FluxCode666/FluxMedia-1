import { randomUUID } from "node:crypto";
import { withApiLogging } from "@repo/shared/api-logger";
import { imageModelIdSchema } from "@repo/shared/image-generation/model-contract";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validateCallbackUrl } from "@/features/external-api/async-image-tasks";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import { createDeprecatedGovernanceFieldResponse } from "@/features/external-api/deprecated-governance-fields";
import {
  buildImageAsyncTaskPublicResponse,
  createImageAsyncTaskPublicSourceFromOperation,
} from "@/features/external-api/image-async-task-response";
import {
  createExternalImageStreamResponse,
  createJsonKeepAliveResponse,
  getExternalFinalImageOutputs,
  getImageBase64,
  getPublicImageUrl,
  IMAGE_JSON_KEEP_ALIVE_INITIAL_WAIT_MS,
  openAIImageError,
  toExternalErrorStreamData,
  toLoggedOpenAIErrorPayload,
  toOpenAIImagesResponse,
  wantsImageStreamResponse,
} from "@/features/external-api/images";
import type { ImageGenerationOperationResult } from "@/features/image-generation/operations";
import {
  normalizeOutputCompression,
  normalizeOutputFormat,
} from "@/features/image-generation/output-format";
import {
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
} from "@/features/image-generation/resolution";
import type { PartialImageResult } from "@/features/image-generation/types";
import {
  invokeImageEnqueueAsyncOperation,
  invokeImageGenerationOperation,
} from "@/features/image-generation/uol-client";

const externalImageGenerationSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
    promptOptimization: z.boolean().optional(),
    prompt_optimization: z.boolean().optional(),
    model: imageModelIdSchema,
    thinking: z
      .enum(["minimal", "none", "low", "medium", "high", "xhigh"])
      .optional(),
    aspectRatio: z.string().trim().min(1).max(64).optional(),
    aspect_ratio: z.string().trim().min(1).max(64).optional(),
    resolution: z.string().trim().min(1).max(64).optional(),
    quality: z.enum(["auto", "low", "medium", "high"]).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    response_format: z.enum(["url", "b64_json"]).optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    // 透明背景抠图回退显式开关(issue #27):true 且 background=transparent 时,后端不支持透明则
    // 服务端 ISNet 抠图得到透明结果;不传则透明直接透传、不支持即返回真实错误。
    transparentMatte: z.boolean().optional(),
    transparent_matte: z.boolean().optional(),
    // 高清修复:上游图偏小需超分时选模型。默认(含省略)=SwinIR(文字/结构复原最佳,较慢);
    // 显式 false=general-x4v3(轻量快)。仅在超分主开关开且触发超分时生效。
    hdRepair: z.boolean().optional(),
    hd_repair: z.boolean().optional(),
    // 分块修复:切成 2×2 web 块逐块 gpt-image-2 重绘再拼接超分;逐块单独计费。默认关。
    blockRepair: z.boolean().optional(),
    block_repair: z.boolean().optional(),
    repairPrompt: z.string().max(8000).optional(),
    repair_prompt: z.string().max(8000).optional(),
    stream: z.boolean().optional(),
    async: z.boolean().optional(),
    callback_url: z.string().url().optional(),
  })
  .strict();

async function toStreamCompletedPayload(
  request: Request,
  result: ImageGenerationOperationResult,
  responseFormat: "url" | "b64_json",
  index: number
) {
  const outputs = getExternalFinalImageOutputs(result);
  const images = [];
  for (const output of outputs) {
    const image =
      responseFormat === "b64_json"
        ? {
            b64_json:
              output.imageBase64 ||
              (await getImageBase64(request, output.imageUrl)),
          }
        : {
            // 纯中转若上游仅给 base64（无 URL），退化为 data: URI 以保证可用。
            url:
              getPublicImageUrl(request, output.imageUrl) ??
              (output.imageBase64
                ? `data:image/png;base64,${output.imageBase64}`
                : undefined),
          };
    images.push({
      ...image,
      revised_prompt: output.revisedPrompt || result.revisedPrompt,
      prompt_repair_notice:
        output.promptRepairNotice || result.promptRepairNotice,
    });
  }
  const primary = images[images.length - 1] || {};

  return {
    type: "image_generation.completed",
    index,
    generation_id: result.generationId,
    generationId: result.generationId,
    model: result.model,
    size: result.size,
    revised_prompt: result.revisedPrompt,
    prompt_repair_notice: result.promptRepairNotice,
    credits_consumed: result.creditsConsumed,
    ...primary,
    data: images,
  };
}

function toPartialPayload(image: PartialImageResult, index: number) {
  return {
    type: "image_generation.partial_image",
    index,
    partial_image_index: image.partialImageIndex,
    b64_json: image.imageBase64,
    url: image.imageUrl,
  };
}

export const postExternalImageGenerations = withApiLogging(
  async (request: NextRequest) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return openAIImageError("Invalid JSON body");
    }

    const deprecatedFieldResponse =
      createDeprecatedGovernanceFieldResponse(body);
    if (deprecatedFieldResponse) {
      return deprecatedFieldResponse;
    }

    const parsed = externalImageGenerationSchema.safeParse(body);
    if (!parsed.success) {
      return openAIImageError(
        parsed.error.issues[0]?.message || "Invalid request"
      );
    }

    // 图像模型的最终能力校验依赖实际选中的后端：pool-api 允许管理员配置的任意
    // 上游模型（如 nano-banana-*、grok-*），OAuth/平台后端仍在管线内保持白名单。
    const imageModel = parsed.data.model;

    const useAsync =
      parsed.data.async === true ||
      request.nextUrl.searchParams.get("async") === "true";
    const useStreamResponse = wantsImageStreamResponse(
      request,
      parsed.data.stream
    );
    if (useAsync && useStreamResponse) {
      return openAIImageError("async cannot be used with stream.");
    }
    let callbackUrl: string | undefined;
    if (parsed.data.callback_url) {
      try {
        callbackUrl = await validateCallbackUrl(parsed.data.callback_url);
      } catch (error) {
        return openAIImageError(
          error instanceof Error ? error.message : "Invalid callback_url."
        );
      }
    }
    const background = parsed.data.background;
    const transparentMatte =
      parsed.data.transparentMatte ?? parsed.data.transparent_matte;

    const input = {
      operation: "generate" as const,
      prompt: parsed.data.prompt,
      promptOptimization:
        parsed.data.promptOptimization ?? parsed.data.prompt_optimization,
      aspectRatio: parsed.data.aspectRatio ?? parsed.data.aspect_ratio,
      resolution: parsed.data.resolution,
      model: imageModel,
      thinking: parsed.data.thinking,
      quality: parsed.data.quality,
      moderation: parsed.data.moderation || "auto",
      outputFormat: normalizeOutputFormat(parsed.data.output_format),
      outputCompression: normalizeOutputCompression(
        parsed.data.output_compression
      ),
      background,
      transparentMatte,
      hdRepair: parsed.data.hdRepair ?? parsed.data.hd_repair,
      blockRepair: parsed.data.blockRepair ?? parsed.data.block_repair,
      repairPrompt: parsed.data.repairPrompt ?? parsed.data.repair_prompt,
    };
    const responseFormat = parsed.data.response_format || "b64_json";
    const principal = {
      type: "apiKey" as const,
      credentialKind: "external" as const,
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
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

    if (useStreamResponse) {
      return createExternalImageStreamResponse(async (emit) => {
        const result = await runGeneration(randomUUID(), {
          onPartialImage: async (image) => {
            await emit({
              event: "image_generation.partial_image",
              data: toPartialPayload(image, 0),
            });
          },
        });
        if (result.error) {
          const errorPayload = toLoggedOpenAIErrorPayload(
            result.error,
            {
              route: "/v1/images/generations",
              stream: true,
              model: imageModel,
            },
            {
              generationId: result.generationId,
              creditsConsumed: result.creditsConsumed,
            }
          );
          await emit({
            event: "error",
            data: toExternalErrorStreamData(result.error, errorPayload),
          });
          return;
        }
        await emit({
          event: "image_generation.completed",
          data: await toStreamCompletedPayload(
            request,
            result,
            responseFormat,
            0
          ),
        });
      });
    }

    if (useAsync) {
      const generationId = randomUUID();
      try {
        const task = await invokeImageEnqueueAsyncOperation(
          {
            taskId: `task_${randomUUID().replace(/-/g, "")}`,
            generationInput: {
              ...input,
              generationId,
            },
            responseFormat,
            ...(callbackUrl ? { callbackUrl } : {}),
          },
          principal,
          requestId
        );
        return Response.json(
          await buildImageAsyncTaskPublicResponse(
            createImageAsyncTaskPublicSourceFromOperation(task, auth.userId)
          )
        );
      } catch (error) {
        return openAIImageError(
          error instanceof Error
            ? error.message
            : "Failed to create async image task."
        );
      }
    }

    return createJsonKeepAliveResponse(
      async () => {
        const created = Math.floor(Date.now() / 1000);

        const result = await runGeneration(randomUUID());
        return await toOpenAIImagesResponse(
          request,
          result,
          responseFormat,
          created,
          {
            route: "/v1/images/generations",
            stream: false,
            model: imageModel,
          }
        );
      },
      { initialWaitMs: IMAGE_JSON_KEEP_ALIVE_INITIAL_WAIT_MS }
    );
  }
);
