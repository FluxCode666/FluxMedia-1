/**
 * 站内视频生成的 UOL 薄传输路由。
 *
 * 职责：校验 session 与受信 Origin，把 data URL 转成 JSON-safe 媒体引用，
 * 构造真实 Principal 并调用 video.generate / video.getStatus。调度、幂等、
 * 计费、归属与存储均由 operation 执行层负责。
 */

import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { invokeOperation, type Principal } from "@repo/shared/uol";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasTrustedImageGenerationOrigin } from "@/features/image-generation/request-security";
import {
  IMAGE_PROMPT_MAX_CHARACTERS,
  IMAGE_PROMPT_TOO_LONG_MESSAGE,
} from "@/features/image-generation/resolution";
import { createImageStreamResponse } from "@/features/image-generation/streaming";
import { ensureUolInitialized } from "@/server/uol-init";

// 输入图：base64 data URL（图生视频首帧/尾帧/参考），最多 3 张。
const inputImageSchema = z
  .string()
  .min(1)
  .max(20_000_000)
  .regex(/^data:image\/[a-zA-Z.+-]+;base64,/, "Invalid image data URL");

const generateVideoSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128),
    prompt: z
      .string()
      .min(1)
      .max(IMAGE_PROMPT_MAX_CHARACTERS, IMAGE_PROMPT_TOO_LONG_MESSAGE),
    model: z.string().trim().min(1).max(120),
    negativePrompt: z.string().max(8000).optional(),
    inputImages: z.array(inputImageSchema).max(3).optional(),
  })
  .strict();

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** data URL 转为 UOL JSON-safe 媒体引用。 */
function decodeImageDataUrl(value: string) {
  const match = value.match(/^data:(image\/[a-zA-Z.+-]+);base64,(.*)$/);
  const mimeType = match?.[1] || "image/png";
  const base64 = match?.[2] || "";
  return {
    source: "data" as const,
    mimeType,
    base64,
    byteLength: Buffer.from(base64, "base64").byteLength,
  };
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

  const inputImages = parsed.data.inputImages?.map(decodeImageDataUrl);
  const principal: Principal = {
    type: "user",
    userId: session.user.id,
    role: await getUserRoleById(session.user.id),
  };
  await ensureUolInitialized();

  return createImageStreamResponse(async (emit) => {
    const result = await invokeOperation<{
      taskId: string;
      status: "pending" | "submitting" | "processing" | "completed" | "failed";
    }>(
      "video.generate",
      {
        clientRequestId: parsed.data.clientRequestId,
        prompt: parsed.data.prompt,
        model: parsed.data.model,
        ...(parsed.data.negativePrompt
          ? { negativePrompt: parsed.data.negativePrompt }
          : {}),
        ...(inputImages?.length ? { inputImages } : {}),
      },
      principal,
      { requestId: request.headers.get("x-request-id") ?? undefined }
    );
    for (;;) {
      if (request.signal.aborted) return null;
      const status = await invokeOperation<{
        taskId: string;
        status:
          | "pending"
          | "submitting"
          | "processing"
          | "completed"
          | "failed";
        videoUrl?: string;
        error?: string;
      }>("video.getStatus", { taskId: result.taskId }, principal);
      if (status.status === "failed") {
        await emit({
          type: "error",
          error: status.error ?? "视频生成失败",
          generationId: result.taskId,
        });
        return null;
      }
      if (status.status === "completed" && status.videoUrl) {
        await emit({
          type: "completed",
          videoGenerationId: result.taskId,
          videoUrl: status.videoUrl,
        });
        return null;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    }
  });
});
