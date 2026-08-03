/**
 * 外部媒体异步响应兼容工具。
 *
 * 职责：校验并安全投递公网 HTTPS 回调，以及把持久 generation/video_generation 行
 * 映射为兼容响应。图片异步任务真相已迁至 PostgreSQL，不在本模块保存进程内状态。
 */
import {
  normalizeHistoricalModelId,
} from "@repo/shared/image-backend/supported-models";
import {
  assertPublicCallbackUrl,
  fetchPublicCallback,
} from "./safe-image-fetch";

type AsyncImageTaskStatus = "processing" | "completed" | "failed";
const CALLBACK_TIMEOUT_MS = 10_000;

/** 提交期校验回调 URL，强制 HTTPS 与公网地址。 */
export async function validateCallbackUrl(value: string): Promise<string> {
  const url = await assertPublicCallbackUrl(value);
  return url.toString();
}

/** 一条 generation 记录(DB 回退查询用的最小字段集)。 */
export type GenerationTaskRow = {
  id: string;
  model: string;
  status: "pending" | "completed" | "failed";
  revisedPrompt: string | null;
  creditsConsumed: string | number | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

/**
 * 把一条 generation 记录转成 /v1/images/{id} 的响应（DB 回退路径，纯函数 DB-free）。
 *
 * 内存异步任务存储是临时态（仅 async=true 创建、按 task_<uuid> 为键、进程内、30 分钟
 * TTL、多实例不共享、重启即清），同步请求拿到的是 generation_id 而非 task id。本函数让
 * 接口可按 generation_id 从 DB 持久取回，对同步/异步、跨实例/重启都稳。归属校验（userId）
 * 由调用方在查库后完成，本函数只做结构映射，不含权限判断。
 *
 * 结构对齐同步成功响应（data:[{url, revised_prompt}]）+ 任务状态字段；并额外给
 * image_url 顶层兜底，便于只取单一 URL 的客户端。
 */
export function toGenerationImageTaskResponse(
  row: GenerationTaskRow,
  imageUrl: string | null
) {
  const status: AsyncImageTaskStatus =
    row.status === "completed"
      ? "completed"
      : row.status === "failed"
        ? "failed"
        : "processing";
  const credits = Number(row.creditsConsumed ?? 0);
  return {
    id: row.id,
    object: status === "completed" ? "image" : "image.generation",
    model: normalizeHistoricalModelId(row.model) ?? row.model,
    status,
    created: Math.floor(row.createdAt.getTime() / 1000),
    created_at: row.createdAt.toISOString(),
    ...(row.completedAt ? { completed_at: row.completedAt.toISOString() } : {}),
    generation_id: row.id,
    generationId: row.id,
    ...(status === "completed" && imageUrl
      ? {
          image_url: imageUrl,
          data: [
            {
              url: imageUrl,
              ...(row.revisedPrompt
                ? { revised_prompt: row.revisedPrompt }
                : {}),
            },
          ],
        }
      : {}),
    ...(status === "failed" && row.error
      ? { error: { message: row.error } }
      : {}),
    ...(Number.isFinite(credits) ? { credits_consumed: credits } : {}),
  };
}

/** 一条 video_generation 记录(DB 回退查询用的最小字段集)。 */
export type VideoTaskRow = {
  id: string;
  model: string;
  // video_generation.status 是 text 列(pending/running/completed/failed),按字符串判定。
  status: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  generateAudio: boolean;
  creditsConsumed: string | number | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date | null;
};

/**
 * 把一条 video_generation 记录转成 /v1/videos/{id} 的响应（DB 持久查询路径,纯函数）。
 * 与图像版同构,但产物是视频 URL,且返回真实模型和全部独立请求参数。
 * 归属校验由调用方完成。
 * video_generation 无 completedAt 列,completed 时以 updatedAt 作为完成时间。
 */
export function toVideoGenerationTaskResponse(
  row: VideoTaskRow,
  videoUrl: string | null
) {
  const status: AsyncImageTaskStatus =
    row.status === "completed"
      ? "completed"
      : row.status === "failed"
        ? "failed"
        : "processing";
  const credits = Number(row.creditsConsumed ?? 0);
  return {
    id: row.id,
    object: status === "completed" ? "video" : "video.generation",
    model: normalizeHistoricalModelId(row.model) ?? row.model,
    status,
    duration: row.durationSeconds,
    duration_seconds: row.durationSeconds,
    aspectRatio: row.aspectRatio,
    aspect_ratio: row.aspectRatio,
    resolution: row.resolution,
    generateAudio: row.generateAudio,
    generate_audio: row.generateAudio,
    created: Math.floor(row.createdAt.getTime() / 1000),
    created_at: row.createdAt.toISOString(),
    ...(status === "completed" && row.updatedAt
      ? { completed_at: row.updatedAt.toISOString() }
      : {}),
    generation_id: row.id,
    generationId: row.id,
    ...(status === "completed" && videoUrl
      ? { video_url: videoUrl, data: [{ url: videoUrl }] }
      : {}),
    ...(status === "failed" && row.error
      ? { error: { message: row.error } }
      : {}),
    ...(Number.isFinite(credits) ? { credits_consumed: credits } : {}),
  };
}

/**
 * 投递已去除身份和输入的持久图片任务公开回调。
 *
 * @param callbackUrl 已通过公网 HTTPS 校验的目标。
 * @param payload 由持久响应组装器生成的公开 JSON-safe 响应。
 * @returns 目标返回 2xx 后返回；超时、重定向到内网或非 2xx 时抛错。
 */
export async function postPublicAsyncImageCallback(
  callbackUrl: string,
  payload: Record<string, unknown>
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  try {
    const response = await fetchPublicCallback(callbackUrl, {
      headers: {
        "Content-Type": "application/json",
        "X-Tokens-Callback": "true",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Callback request failed with ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
