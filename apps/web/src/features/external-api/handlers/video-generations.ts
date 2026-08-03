/**
 * 外部视频创建 API 的 UOL 薄适配器。
 *
 * 职责：认证 API Key、校验传输格式、构造 API Key Principal 并调用 video.generate。
 * 调度、计费、幂等与恢复均在 operation 执行层；本文件不创建进程内异步任务。
 */

import { withApiLogging } from "@repo/shared/api-logger";
import { MAX_MEDIA_INPUT_COUNT } from "@repo/shared/image-generation/media-contract";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import {
  videoRequestedModelIdSchema,
  videoRequestedResolutionSchema,
} from "@repo/shared/uol/operations/video-generation";
import { videoAspectRatioSchema } from "@repo/shared/video-generation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { validateCallbackUrl } from "@/features/external-api/async-image-tasks";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import { createDeprecatedGovernanceFieldResponse } from "@/features/external-api/deprecated-governance-fields";
import { openAIImageError } from "@/features/external-api/images";
import {
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
} from "@/features/image-generation/resolution";
import {
  toVideoMediaInputReference,
  videoInputImageDataUrlSchema,
} from "@/features/image-generation/video-transport-input";
import { ensureUolInitialized } from "@/server/uol-init";

const optionalReferenceImagesSchema = z
  .array(videoInputImageDataUrlSchema)
  .min(1)
  .max(MAX_MEDIA_INPUT_COUNT)
  .optional();

/** 判断 v1 同一语义的两个传输别名是否完全一致。 */
function areVideoAliasesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

/** 为冲突别名追加稳定 Zod issue，避免静默选择其中一个值。 */
function addVideoAliasConflict(
  context: z.RefinementCtx,
  camelField: string,
  snakeField: string,
  camelValue: unknown,
  snakeValue: unknown
): void {
  if (areVideoAliasesEqual(camelValue, snakeValue)) return;
  context.addIssue({
    code: "custom",
    message: `${camelField} and ${snakeField} must match`,
    path: [camelField],
  });
}

const externalVideoSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128).optional(),
    client_request_id: z.string().trim().min(1).max(128).optional(),
    prompt: z
      .string()
      .min(1)
      .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
    model: videoRequestedModelIdSchema,
    duration: z.number().int().positive().optional(),
    duration_seconds: z.number().int().positive().optional(),
    aspectRatio: videoAspectRatioSchema.optional(),
    aspect_ratio: videoAspectRatioSchema.optional(),
    resolution: videoRequestedResolutionSchema,
    negativePrompt: z.string().max(8_000).optional(),
    negative_prompt: z.string().max(8_000).optional(),
    generateAudio: z.boolean().optional(),
    generate_audio: z.boolean().optional(),
    firstFrame: videoInputImageDataUrlSchema.optional(),
    first_frame: videoInputImageDataUrlSchema.optional(),
    lastFrame: videoInputImageDataUrlSchema.optional(),
    last_frame: videoInputImageDataUrlSchema.optional(),
    referenceImages: optionalReferenceImagesSchema,
    reference_images: optionalReferenceImagesSchema,
    async: z.boolean().optional(),
    callback_url: z.string().url().max(2_048).optional(),
    callbackUrl: z.string().url().max(2_048).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.clientRequestId && !value.client_request_id) {
      context.addIssue({
        code: "custom",
        message: "clientRequestId is required",
        path: ["clientRequestId"],
      });
    }
    if (value.duration === undefined && value.duration_seconds === undefined) {
      context.addIssue({
        code: "custom",
        message: "duration is required",
        path: ["duration"],
      });
    }
    if (value.aspectRatio === undefined && value.aspect_ratio === undefined) {
      context.addIssue({
        code: "custom",
        message: "aspectRatio is required",
        path: ["aspectRatio"],
      });
    }
    addVideoAliasConflict(
      context,
      "clientRequestId",
      "client_request_id",
      value.clientRequestId,
      value.client_request_id
    );
    addVideoAliasConflict(
      context,
      "duration",
      "duration_seconds",
      value.duration,
      value.duration_seconds
    );
    addVideoAliasConflict(
      context,
      "aspectRatio",
      "aspect_ratio",
      value.aspectRatio,
      value.aspect_ratio
    );
    addVideoAliasConflict(
      context,
      "negativePrompt",
      "negative_prompt",
      value.negativePrompt,
      value.negative_prompt
    );
    addVideoAliasConflict(
      context,
      "generateAudio",
      "generate_audio",
      value.generateAudio,
      value.generate_audio
    );
    addVideoAliasConflict(
      context,
      "firstFrame",
      "first_frame",
      value.firstFrame,
      value.first_frame
    );
    addVideoAliasConflict(
      context,
      "lastFrame",
      "last_frame",
      value.lastFrame,
      value.last_frame
    );
    addVideoAliasConflict(
      context,
      "referenceImages",
      "reference_images",
      value.referenceImages,
      value.reference_images
    );
    addVideoAliasConflict(
      context,
      "callbackUrl",
      "callback_url",
      value.callbackUrl,
      value.callback_url
    );
  });

/** 将 UOL 错误转换为稳定 OpenAI 风格错误。 */
function operationErrorResponse(error: OperationError) {
  return openAIImageError(error.message, error.httpStatus, error.code);
}

export const postExternalVideoGenerations = withApiLogging(
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
    const deprecated = createDeprecatedGovernanceFieldResponse(body);
    if (deprecated) return deprecated;
    const parsed = externalVideoSchema.safeParse(body);
    if (!parsed.success) {
      return openAIImageError(
        parsed.error.issues[0]?.message || "Invalid request"
      );
    }

    const clientRequestId =
      parsed.data.clientRequestId ?? parsed.data.client_request_id;
    if (!clientRequestId)
      return openAIImageError("clientRequestId is required");
    const negativePrompt =
      parsed.data.negativePrompt ?? parsed.data.negative_prompt;
    const generateAudio =
      parsed.data.generateAudio ?? parsed.data.generate_audio;
    const duration = parsed.data.duration ?? parsed.data.duration_seconds;
    const aspectRatio = parsed.data.aspectRatio ?? parsed.data.aspect_ratio;
    if (duration === undefined || aspectRatio === undefined) {
      return openAIImageError("Missing required video parameters");
    }
    const rawFirstFrame = parsed.data.firstFrame ?? parsed.data.first_frame;
    const rawLastFrame = parsed.data.lastFrame ?? parsed.data.last_frame;
    const rawReferenceImages =
      parsed.data.referenceImages ?? parsed.data.reference_images;
    const firstFrame = rawFirstFrame
      ? toVideoMediaInputReference(rawFirstFrame)
      : undefined;
    const lastFrame = rawLastFrame
      ? toVideoMediaInputReference(rawLastFrame)
      : undefined;
    const referenceImages = rawReferenceImages?.map(toVideoMediaInputReference);
    let callbackUrl: string | undefined;
    if (parsed.data.callback_url || parsed.data.callbackUrl) {
      try {
        callbackUrl = await validateCallbackUrl(
          parsed.data.callback_url ?? parsed.data.callbackUrl ?? ""
        );
      } catch (error) {
        return openAIImageError(
          error instanceof Error ? error.message : "Invalid callback URL"
        );
      }
    }
    try {
      await ensureUolInitialized();
      const result = await invokeOperation<{
        taskId: string;
        status:
          | "pending"
          | "submitting"
          | "processing"
          | "needs_attention"
          | "completed"
          | "failed";
      }>(
        "video.generate",
        {
          clientRequestId,
          prompt: parsed.data.prompt,
          model: parsed.data.model,
          duration,
          aspectRatio,
          resolution: parsed.data.resolution,
          ...(negativePrompt ? { negativePrompt } : {}),
          ...(generateAudio !== undefined ? { generateAudio } : {}),
          ...(firstFrame ? { firstFrame } : {}),
          ...(lastFrame ? { lastFrame } : {}),
          ...(referenceImages?.length ? { referenceImages } : {}),
        },
        {
          type: "apiKey",
          credentialKind: "external",
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          plan: auth.plan,
        },
        {
          requestId: request.headers.get("x-request-id") ?? undefined,
          // callback 仅存在于受信执行上下文，不进入领域输入或任务 metadata。
          callbacks: callbackUrl
            ? { videoCompletionUrl: callbackUrl }
            : undefined,
        }
      );
      return Response.json(
        {
          object: "video.task",
          id: result.taskId,
          task_id: result.taskId,
          generation_id: result.taskId,
          status: result.status,
          model: parsed.data.model,
          duration,
          duration_seconds: duration,
          aspectRatio,
          aspect_ratio: aspectRatio,
          resolution: parsed.data.resolution,
          ...(generateAudio !== undefined
            ? {
                generateAudio,
                generate_audio: generateAudio,
              }
            : {}),
        },
        { status: 202, headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      if (error instanceof OperationError) return operationErrorResponse(error);
      throw error;
    }
  }
);
