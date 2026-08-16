/**
 * 站内视频生成的 UOL 薄传输路由。
 *
 * 职责：校验 session 与受信 Origin，把 data URL 转成 JSON-safe 媒体引用，
 * 构造真实 Principal 并调用 video.generate，随后立即返回 accepted/taskId。调度、
 * 计费、恢复、归属与状态查询均由 operation 及独立状态路由负责。
 */

import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { MAX_MEDIA_INPUT_COUNT } from "@repo/shared/image-generation/media-contract";
import {
  invokeOperation,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import {
  videoRequestedModelIdSchema,
  videoRequestedResolutionSchema,
} from "@repo/shared/uol/operations/video-generation";
import {
  type VideoTaskPublicBilling,
  videoAspectRatioSchema,
  videoCurrentQuoteSchema,
} from "@repo/shared/video-generation";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasTrustedImageGenerationOrigin } from "@/features/image-generation/request-security";
import {
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
} from "@/features/image-generation/resolution";
import {
  toVideoMediaInputReference,
  videoInputImageDataUrlSchema,
} from "@/features/image-generation/video-transport-input";
import { ensureUolInitialized } from "@/server/uol-init";

const generateVideoSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128),
    prompt: z
      .string()
      .min(1)
      .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
    model: videoRequestedModelIdSchema,
    duration: z.number().int().positive(),
    aspectRatio: videoAspectRatioSchema,
    resolution: videoRequestedResolutionSchema,
    quoteToken: z.string().trim().min(1).max(2_048).optional(),
    negativePrompt: z.string().max(8000).optional(),
    generateAudio: z.boolean().optional(),
    firstFrame: videoInputImageDataUrlSchema.optional(),
    lastFrame: videoInputImageDataUrlSchema.optional(),
    referenceImages: z
      .array(videoInputImageDataUrlSchema)
      .min(1)
      .max(MAX_MEDIA_INPUT_COUNT)
      .optional(),
  })
  .strict();

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** 将 UOL 错误收窄为站内可处理响应；只有陈旧报价公开新的 current_quote。 */
function operationErrorResponse(error: OperationError) {
  const currentQuote = videoCurrentQuoteSchema.safeParse(
    error.details?.currentQuote
  );
  if (
    error.code === "conflict" &&
    error.details?.reason === "stale_video_quote" &&
    currentQuote.success
  ) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        reason: "stale_video_quote",
        currentQuote: currentQuote.data,
      },
      { status: error.httpStatus }
    );
  }
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: error.httpStatus }
  );
}

export const POST = withApiLogging(async (request: NextRequest) => {
  const session = await auth.api.getSession({ headers: request.headers });
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

  const parsed = generateVideoSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message || "Invalid request");
  }

  const firstFrame = parsed.data.firstFrame
    ? toVideoMediaInputReference(parsed.data.firstFrame)
    : undefined;
  const lastFrame = parsed.data.lastFrame
    ? toVideoMediaInputReference(parsed.data.lastFrame)
    : undefined;
  const referenceImages = parsed.data.referenceImages?.map(
    toVideoMediaInputReference
  );
  const principal: Principal = {
    type: "user",
    userId: session.user.id,
    role: await getUserRoleById(session.user.id),
  };
  await ensureUolInitialized();

  try {
    const result = await invokeOperation<{
      taskId: string;
      status: "queued" | "in_progress" | "completed" | "failed";
      billing: VideoTaskPublicBilling;
      error?: string;
    }>(
      "video.generate",
      {
        clientRequestId: parsed.data.clientRequestId,
        prompt: parsed.data.prompt,
        model: parsed.data.model,
        duration: parsed.data.duration,
        aspectRatio: parsed.data.aspectRatio,
        resolution: parsed.data.resolution,
        ...(parsed.data.quoteToken
          ? { quoteToken: parsed.data.quoteToken }
          : {}),
        ...(parsed.data.negativePrompt
          ? { negativePrompt: parsed.data.negativePrompt }
          : {}),
        ...(parsed.data.generateAudio !== undefined
          ? { generateAudio: parsed.data.generateAudio }
          : {}),
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        ...(referenceImages?.length ? { referenceImages } : {}),
      },
      principal,
      {
        externalRequestId: request.headers.get("x-request-id") ?? undefined,
      }
    );
    return NextResponse.json(
      {
        ...result,
        model: parsed.data.model,
        duration: parsed.data.duration,
        aspectRatio: parsed.data.aspectRatio,
        resolution: parsed.data.resolution,
      },
      {
        status: 202,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    if (error instanceof OperationError) return operationErrorResponse(error);
    throw error;
  }
});
