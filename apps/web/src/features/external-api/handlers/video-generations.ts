/**
 * 外部视频创建 API 的 UOL 薄适配器。
 *
 * 职责：认证 API Key、校验传输格式、构造 API Key Principal 并调用 video.generate。
 * 调度、计费、幂等与恢复均在 operation 执行层；本文件不创建进程内异步任务。
 */

import { withApiLogging } from "@repo/shared/api-logger";
import { invokeOperation, OperationError } from "@repo/shared/uol";
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

const externalVideoSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128).optional(),
    client_request_id: z.string().trim().min(1).max(128).optional(),
    prompt: z
      .string()
      .min(1)
      .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
    model: z.string().trim().min(1).max(120),
    negativePrompt: z.string().max(8_000).optional(),
    negative_prompt: z.string().max(8_000).optional(),
    generateAudio: z.boolean().optional(),
    generate_audio: z.boolean().optional(),
    image: z.array(videoInputImageDataUrlSchema).max(3).optional(),
    inputImageRole: z.enum(["frame", "reference"]).optional(),
    input_image_role: z.enum(["frame", "reference"]).optional(),
    async: z.boolean().optional(),
    callback_url: z.string().url().max(2_048).optional(),
    callbackUrl: z.string().url().max(2_048).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.clientRequestId ?? value.client_request_id),
    { message: "clientRequestId is required", path: ["clientRequestId"] }
  )
  .refine(
    (value) =>
      value.generateAudio === undefined ||
      value.generate_audio === undefined ||
      value.generateAudio === value.generate_audio,
    {
      message: "generateAudio and generate_audio must match",
      path: ["generateAudio"],
    }
  )
  .refine(
    (value) =>
      value.inputImageRole === undefined ||
      value.input_image_role === undefined ||
      value.inputImageRole === value.input_image_role,
    {
      message: "inputImageRole and input_image_role must match",
      path: ["inputImageRole"],
    }
  );

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
    const inputImages = parsed.data.image?.map(toVideoMediaInputReference);
    const inputImageRole =
      parsed.data.inputImageRole ?? parsed.data.input_image_role;
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
          ...(negativePrompt ? { negativePrompt } : {}),
          ...(generateAudio !== undefined ? { generateAudio } : {}),
          ...(inputImages?.length ? { inputImages } : {}),
          ...(inputImageRole ? { inputImageRole } : {}),
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
        },
        { status: 202, headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      if (error instanceof OperationError) return operationErrorResponse(error);
      throw error;
    }
  }
);
