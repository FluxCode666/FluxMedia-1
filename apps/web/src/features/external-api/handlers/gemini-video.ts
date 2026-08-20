/**
 * Gemini Veo 兼容视频 API 的薄适配器。
 *
 * 职责：认证 API Key、严格解析 Gemini REST body、转换为 video.generate UOL 输入并投影
 * Operation。真实调度、计费、存储和恢复仍由统一视频状态机负责。
 */
import { invokeOperation, OperationError } from "@repo/shared/uol";
import {
  geminiModelPathSchema,
  geminiVideoRequestSchema,
} from "@repo/shared/video-generation";
import { nanoid } from "nanoid";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import { toVideoMediaInputReference } from "@/features/image-generation/video-transport-input";
import { ensureUolInitialized } from "@/server/uol-init";

/** Gemini 错误响应的最小稳定投影。 */
function geminiErrorResponse(
  message: string,
  status = 400,
  code = status >= 500 ? 13 : status === 401 ? 16 : 3
): Response {
  return Response.json(
    {
      error: {
        code,
        message: message.slice(0, 512),
        status: statusName(status),
      },
    },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/** 将 HTTP 状态映射为 Google Status 风格的稳定大写名称。 */
function statusName(status: number): string {
  if (status === 400) return "INVALID_ARGUMENT";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "ABORTED";
  if (status === 429) return "RESOURCE_EXHAUSTED";
  return status >= 500 ? "INTERNAL" : "FAILED_PRECONDITION";
}

/** 判断幂等键是否包含 ASCII 控制字符，避免控制字符进入任务身份。 */
function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

/** 将 Gemini Developer API 模型公开名映射到 FluxMedia 内部模型 ID。 */
function resolvePlatformVideoModel(model: string): string {
  const aliases: Record<string, string> = {
    "veo-3.1-generate-preview": "veo31",
    "veo-3.1-fast-generate-preview": "veo31-fast",
  };
  return aliases[model] ?? model;
}

/** 将 Gemini inlineData 转成平台现有 data URL 输入引用。 */
function toPlatformImage(image: {
  inlineData: { mimeType: string; data: string };
}) {
  return toVideoMediaInputReference(
    `data:${image.inlineData.mimeType};base64,${image.inlineData.data}`
  );
}

/** 认证并创建 Gemini LRO 任务。 */
export async function postGeminiVideoGeneration(
  request: NextRequest,
  { params }: { params: Promise<{ model: string }> }
): Promise<Response> {
  const auth = await authenticateExternalApiRequest(request);
  if (!auth) return geminiErrorResponse("Invalid or missing API key", 401, 16);
  const pathModel = geminiModelPathSchema.safeParse((await params).model);
  if (!pathModel.success) return geminiErrorResponse("Invalid model name");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return geminiErrorResponse("Request body must be valid JSON");
  }
  const parsed = geminiVideoRequestSchema.safeParse(body);
  if (!parsed.success) {
    return geminiErrorResponse(
      parsed.error.issues[0]?.message ?? "Invalid request"
    );
  }
  const instance = parsed.data.instances[0];
  if (!instance) return geminiErrorResponse("instances must contain one item");
  const parameters = parsed.data.parameters;
  const duration = Number(parameters?.durationSeconds ?? "8");
  const aspectRatio = parameters?.aspectRatio ?? "16:9";
  const resolution = parameters?.resolution ?? "720p";
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  const requestIdHeader = request.headers.get("x-request-id")?.trim();
  if (idempotencyKey && requestIdHeader && idempotencyKey !== requestIdHeader) {
    return geminiErrorResponse("Idempotency-Key and x-request-id must match");
  }
  const suppliedClientRequestId = idempotencyKey || requestIdHeader;
  if (
    suppliedClientRequestId &&
    (suppliedClientRequestId.length > 128 ||
      containsAsciiControlCharacter(suppliedClientRequestId))
  ) {
    return geminiErrorResponse(
      "Idempotency key must be at most 128 characters"
    );
  }
  const clientRequestId = suppliedClientRequestId || nanoid(32);
  const geminiOperationId = nanoid(24);
  const firstFrame = instance.image
    ? toPlatformImage(instance.image)
    : undefined;
  const lastFrame = instance.lastFrame
    ? toPlatformImage(instance.lastFrame)
    : undefined;
  const referenceImages = instance.referenceImages?.map((item) =>
    toPlatformImage(item.image)
  );
  try {
    await ensureUolInitialized();
    const result = await invokeOperation<{
      taskId: string;
      status: "queued" | "in_progress" | "completed" | "failed";
      geminiOperationId?: string;
      error?: string;
    }>(
      "video.generate",
      {
        clientRequestId,
        geminiOperationId,
        geminiModel: pathModel.data,
        prompt: instance.prompt,
        model: resolvePlatformVideoModel(pathModel.data),
        duration,
        aspectRatio,
        resolution,
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        ...(referenceImages?.length ? { referenceImages } : {}),
      },
      {
        type: "apiKey",
        credentialKind: "external",
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
      },
      { externalRequestId: request.headers.get("x-request-id") ?? undefined }
    );
    const operationId = result.geminiOperationId ?? geminiOperationId;
    const name = `models/${pathModel.data}/operations/${operationId}`;
    if (result.status === "failed") {
      return Response.json(
        {
          name,
          done: true,
          error: {
            code: 13,
            message: result.error ?? "视频任务失败",
            status: "FAILED",
          },
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }
    return Response.json(
      { name, done: false },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof OperationError) {
      const status = error.httpStatus;
      return geminiErrorResponse(
        error.message,
        status,
        status === 404 ? 5 : undefined
      );
    }
    throw error;
  }
}

/** 查询平台生成的 Gemini Operation；完整 name 由路由参数重新组装。 */
export async function getGeminiVideoOperation(
  request: NextRequest,
  { params }: { params: Promise<{ model: string; operationId: string }> }
): Promise<Response> {
  const auth = await authenticateExternalApiRequest(request);
  if (!auth) return geminiErrorResponse("Invalid or missing API key", 401, 16);
  const resolved = await params;
  const pathModel = geminiModelPathSchema.safeParse(resolved.model);
  const operationId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .safeParse(resolved.operationId);
  if (!pathModel.success || !operationId.success) {
    return geminiErrorResponse("Operation not found", 404, 5);
  }
  try {
    await ensureUolInitialized();
    const result = await invokeOperation(
      "video.getGeminiOperation",
      {
        model: pathModel.data,
        operationName: `models/${pathModel.data}/operations/${operationId.data}`,
      },
      {
        type: "apiKey",
        credentialKind: "external",
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
      },
      { externalRequestId: request.headers.get("x-request-id") ?? undefined }
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OperationError) {
      return geminiErrorResponse(
        error.message,
        error.httpStatus,
        error.httpStatus === 404 ? 5 : undefined
      );
    }
    throw error;
  }
}
