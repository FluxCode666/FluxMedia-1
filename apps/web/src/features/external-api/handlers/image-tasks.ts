import { withApiLogging } from "@repo/shared/api-logger";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { OperationError } from "@repo/shared/uol";
import type { NextRequest } from "next/server";
import { toGenerationImageTaskResponse } from "@/features/external-api/async-image-tasks";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import {
  buildImageAsyncTaskPublicResponse,
  createImageAsyncTaskPublicSourceFromOperation,
} from "@/features/external-api/image-async-task-response";
import { openAIImageError } from "@/features/external-api/images";
import { getGenerationById } from "@/features/image-generation/queries";
import { invokeImageGetAsyncTaskOperation } from "@/features/image-generation/uol-client";

export const getExternalImageTask = withApiLogging(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ taskId: string }> }
  ) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    }

    const { taskId } = await params;
    if (!taskId || taskId.length > 128) {
      return openAIImageError("Invalid task_id.");
    }

    const principal = {
      type: "apiKey" as const,
      credentialKind: "external" as const,
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
    };
    try {
      const task = await invokeImageGetAsyncTaskOperation(
        { taskId },
        principal,
        request.headers.get("x-request-id") ?? undefined
      );
      return Response.json(
        await buildImageAsyncTaskPublicResponse(
          createImageAsyncTaskPublicSourceFromOperation(task, auth.userId)
        ),
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      if (!(error instanceof OperationError) || error.code !== "not_found") {
        return openAIImageError(
          error instanceof Error
            ? error.message
            : "Failed to query image task.",
          error instanceof OperationError ? error.httpStatus : 500
        );
      }
    }

    // 同步请求拿到的是 generation_id 而非 task id，因此 UOL task 未命中时继续使用
    // generation 持久回退；查询后必须显式校验 userId 防止 IDOR。
    const row = await getGenerationById(taskId);
    if (row && row.userId === auth.userId) {
      const imageUrl = row.storageKey
        ? buildSignedStorageImageUrl(row.storageKey, row.storageBucket)
        : null;
      return Response.json(toGenerationImageTaskResponse(row, imageUrl), {
        headers: { "Cache-Control": "no-store" },
      });
    }

    return openAIImageError("Image task not found or expired.", 404);
  }
);
