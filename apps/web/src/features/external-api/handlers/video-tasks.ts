/**
 * 外部视频状态查询的 UOL 薄适配器。
 *
 * 职责：认证 API Key、构造包含精确 apiKeyId 的 Principal 并委托 video.getStatus。
 * 任务归属由 operation 以 userId + apiKeyId fail closed 校验，不读取进程内任务状态。
 */

import { withApiLogging } from "@repo/shared/api-logger";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import type { NextRequest } from "next/server";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import { openAIImageError } from "@/features/external-api/images";
import { ensureUolInitialized } from "@/server/uol-init";

export const getExternalVideoTask = withApiLogging(
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
    try {
      await ensureUolInitialized();
      const result = await invokeOperation<{
        taskId: string;
        status: "queued" | "in_progress" | "completed" | "failed";
        model: string;
        duration: number;
        aspectRatio: string;
        resolution: string;
        generateAudio: boolean;
        input: {
          mode: "none" | "first-frame" | "first-last-frames" | "references";
          count: number;
        };
        videoUrl?: string;
        error?: string;
        createdAt: string;
        completedAt?: string;
      }>(
        "video.getStatus",
        { taskId },
        {
          type: "apiKey",
          credentialKind: "external",
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
        },
        { requestId: request.headers.get("x-request-id") ?? undefined }
      );
      return Response.json(
        {
          object: "video.task",
          id: result.taskId,
          task_id: result.taskId,
          generation_id: result.taskId,
          status: result.status,
          model: result.model,
          duration: result.duration,
          duration_seconds: result.duration,
          aspectRatio: result.aspectRatio,
          aspect_ratio: result.aspectRatio,
          resolution: result.resolution,
          generateAudio: result.generateAudio,
          generate_audio: result.generateAudio,
          input: result.input,
          ...(result.videoUrl
            ? { video_url: result.videoUrl, data: [{ url: result.videoUrl }] }
            : {}),
          ...(result.error ? { error: { message: result.error } } : {}),
          created_at: result.createdAt,
          ...(result.completedAt ? { completed_at: result.completedAt } : {}),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      if (error instanceof OperationError) {
        return openAIImageError(error.message, error.httpStatus, error.code);
      }
      throw error;
    }
  }
);
