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
import { invokeOperation, type Principal } from "@repo/shared/uol";
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
    model: z.string().trim().min(1).max(120),
    negativePrompt: z.string().max(8000).optional(),
    generateAudio: z.boolean().optional(),
    inputImages: z.array(videoInputImageDataUrlSchema).max(3).optional(),
    inputImageRole: z.enum(["frame", "reference"]).optional(),
  })
  .strict();

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
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

  const inputImages = parsed.data.inputImages?.map(toVideoMediaInputReference);
  const principal: Principal = {
    type: "user",
    userId: session.user.id,
    role: await getUserRoleById(session.user.id),
  };
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
      clientRequestId: parsed.data.clientRequestId,
      prompt: parsed.data.prompt,
      model: parsed.data.model,
      ...(parsed.data.negativePrompt
        ? { negativePrompt: parsed.data.negativePrompt }
        : {}),
      ...(parsed.data.generateAudio !== undefined
        ? { generateAudio: parsed.data.generateAudio }
        : {}),
      ...(inputImages?.length ? { inputImages } : {}),
      ...(parsed.data.inputImageRole
        ? { inputImageRole: parsed.data.inputImageRole }
        : {}),
    },
    principal,
    { requestId: request.headers.get("x-request-id") ?? undefined }
  );
  return NextResponse.json(result, {
    status: 202,
    headers: { "Cache-Control": "no-store" },
  });
});
