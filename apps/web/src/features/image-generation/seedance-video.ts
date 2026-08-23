/**
 * Seedance/Ark 上游视频适配器。
 *
 * 职责：把固定 API 成员的规范视频输入转换为 Seedance 长任务 REST 请求，解析任务
 * ID、状态和 content.video_url 结果。该模块不执行 custom 脚本，也不负责调度、计费、
 * 持久化或公共响应投影。
 */
import type { ApiUpstreamAdapterDraft } from "@repo/shared/image-backend/api-upstream-adaptation";
import type { ApiUpstreamRequestSnapshot } from "@repo/shared/image-backend/api-upstream-script-contract";
import { createApiUpstreamAuthenticationHeaders } from "@/features/image-backend-pool/api-upstream-auth";
import { createApiUpstreamRequestSnapshot } from "@/features/image-backend-pool/api-upstream-request-snapshot";
import { fetchMediaUpstream } from "@/features/image-backend-pool/media-upstream-fetch";
import type { ApiVideoSourceImage } from "./api-video";
import { ApiAcceptedVideoError } from "./api-video-error";

const MAX_SEEDANCE_RESPONSE_BYTES = 2 * 1024 * 1024;
const PENDING_STATUSES = new Set([
  "created",
  "queued",
  "pending",
  "processing",
  "running",
  "in_progress",
]);
const COMPLETED_STATUSES = new Set([
  "completed",
  "succeeded",
  "success",
  "done",
]);
const FAILED_STATUSES = new Set([
  "failed",
  "error",
  "cancelled",
  "canceled",
  "rejected",
]);

type SeedanceStageError = {
  error: string;
  failure: {
    kind:
      | "timeout"
      | "network"
      | "response_read"
      | "response_parse"
      | "missing_task_id"
      | "unknown";
    statusCode?: number;
  };
  retryAfterSeconds?: number;
};

export type SeedanceVideoSubmission =
  | {
      status: "pending";
      upstreamJobId: string;
      raw: Record<string, unknown>;
      pollAfterSeconds?: number;
    }
  | { status: "completed"; videoUrl: string; raw: Record<string, unknown> };

export type SeedanceVideoPollResult =
  | {
      status: "pending";
      raw: Record<string, unknown>;
      pollAfterSeconds?: number;
    }
  | { status: "completed"; videoUrl: string; raw: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function readJson(
  response: Response
): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(300, Math.floor(seconds))
    : undefined;
}

function authHeaders(
  adapter: ApiUpstreamAdapterDraft,
  apiKey: string | null
): Record<string, string> {
  return createApiUpstreamAuthenticationHeaders(adapter.authentication, apiKey);
}

function createSeedanceBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function createSeedanceSubmitUrl(baseUrl: string): string {
  const normalized = createSeedanceBaseUrl(baseUrl);
  return normalized.endsWith("/api/v3")
    ? `${normalized}/contents/generations/tasks`
    : `${normalized}/api/v3/contents/generations/tasks`;
}

function createSeedanceQueryUrl(baseUrl: string, taskId: string): string {
  return `${createSeedanceSubmitUrl(baseUrl)}/${encodeURIComponent(taskId)}`;
}

function encodeImage(image: ApiVideoSourceImage): {
  type: "image_url";
  image_url: { url: string };
} {
  return {
    type: "image_url",
    image_url: {
      url: `data:${image.type};base64,${image.data.toString("base64")}`,
    },
  };
}

function parseVideoUrl(record: Record<string, unknown>): string | undefined {
  const direct = readString(record, ["video_url", "output_url", "url"]);
  if (direct) return direct;
  const content = Array.isArray(record.content) ? record.content : [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const video = item.video_url;
    if (isRecord(video)) {
      const url = readString(video, ["url"]);
      if (url) return url;
    }
    if (typeof video === "string" && video.trim()) return video.trim();
  }
  return undefined;
}

function normalizeVideoUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseSubmission(
  record: Record<string, unknown>
): SeedanceVideoSubmission | SeedanceStageError {
  const taskId = readString(record, ["id", "task_id", "generation_id"]);
  const status = readString(record, ["status", "state"])?.toLowerCase();
  const videoUrl = parseVideoUrl(record);
  if (videoUrl) {
    const normalized = normalizeVideoUrl(videoUrl);
    return normalized
      ? { status: "completed", videoUrl: normalized, raw: record }
      : {
          error: "Seedance 视频上游返回了无效视频地址",
          failure: { kind: "response_parse" },
        };
  }
  if (status && FAILED_STATUSES.has(status)) {
    return {
      error: "Seedance 视频上游拒绝了生成请求",
      failure: { kind: "unknown", statusCode: 400 },
    };
  }
  if (!taskId) {
    return {
      error: "Seedance 视频上游响应缺少任务 ID",
      failure: { kind: "missing_task_id" },
    };
  }
  return {
    status: "pending",
    upstreamJobId: taskId,
    raw: record,
  };
}

function parsePoll(record: Record<string, unknown>): SeedanceVideoPollResult {
  const status = readString(record, ["status", "state"])?.toLowerCase();
  if (status && FAILED_STATUSES.has(status)) {
    throw new ApiAcceptedVideoError("Seedance 视频任务失败", false);
  }
  const videoUrl = parseVideoUrl(record);
  if (videoUrl) {
    const normalized = normalizeVideoUrl(videoUrl);
    if (!normalized) {
      throw new ApiAcceptedVideoError("Seedance 视频结果地址无效", false);
    }
    return { status: "completed", videoUrl: normalized, raw: record };
  }
  if (!status || PENDING_STATUSES.has(status)) {
    return { status: "pending", raw: record };
  }
  if (COMPLETED_STATUSES.has(status)) {
    throw new ApiAcceptedVideoError(
      "Seedance 视频任务已完成但响应缺少视频地址",
      false
    );
  }
  throw new ApiAcceptedVideoError("Seedance 视频任务返回未知状态", true);
}

export async function submitSeedanceVideoRequest(input: {
  adapter: ApiUpstreamAdapterDraft;
  apiKey: string | null;
  upstreamModel: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  effectiveAudio: boolean;
  firstFrame?: ApiVideoSourceImage;
  lastFrame?: ApiVideoSourceImage;
  referenceImages?: ApiVideoSourceImage[];
  referenceVideos?: readonly string[];
  referenceAudios?: readonly string[];
  /** 真正发出上游请求前预留 API 创建尝试次数。 */
  onBeforeSend?: () => Promise<void> | void;
  /** 持久化不含媒体正文和凭据的最终请求快照。 */
  onRequestSnapshot?: (
    snapshot: ApiUpstreamRequestSnapshot
  ) => Promise<void> | void;
  signal?: AbortSignal;
}): Promise<SeedanceVideoSubmission | SeedanceStageError> {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: input.prompt },
  ];
  if (input.firstFrame) content.push(encodeImage(input.firstFrame));
  if (input.lastFrame) content.push(encodeImage(input.lastFrame));
  if (input.referenceImages?.length) {
    content.push(...input.referenceImages.map(encodeImage));
  }
  const body = {
    model: input.upstreamModel,
    content,
    ratio: input.aspectRatio,
    duration: input.duration,
    resolution: input.resolution,
    watermark: false,
    ...(input.effectiveAudio ? { generate_audio: true } : {}),
    ...(input.referenceVideos?.length
      ? { reference_videos: input.referenceVideos }
      : {}),
    ...(input.referenceAudios?.length
      ? { reference_audios: input.referenceAudios }
      : {}),
  };
  try {
    await input.onRequestSnapshot?.(
      createApiUpstreamRequestSnapshot({
        operation: "videos.generate",
        contentType: "application/json",
        body,
      })
    );
  } catch {
    return {
      error: "Seedance 视频请求快照生成失败",
      failure: { kind: "unknown" },
    };
  }
  let response: Response;
  try {
    await input.onBeforeSend?.();
  } catch {
    return {
      error: "Seedance 视频请求尚未发送",
      failure: { kind: "unknown" },
    };
  }
  try {
    response = await fetchMediaUpstream(
      createSeedanceSubmitUrl(input.adapter.baseUrl),
      {
        method: "POST",
        headers: {
          ...authHeaders(input.adapter, input.apiKey),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: input.signal,
        maxResponseBytes: MAX_SEEDANCE_RESPONSE_BYTES,
      }
    );
  } catch {
    return {
      error: "Seedance 视频上游请求失败",
      failure: { kind: input.signal?.aborted ? "timeout" : "network" },
    };
  }
  if (!response.ok) {
    return {
      error: `Seedance 视频上游返回 HTTP ${response.status}`,
      failure: { kind: "unknown", statusCode: response.status },
      ...(retryAfter(response) !== undefined
        ? { retryAfterSeconds: retryAfter(response) }
        : {}),
    };
  }
  let record: Record<string, unknown> | null;
  try {
    record = await readJson(response);
  } catch {
    return {
      error: "Seedance 视频上游响应读取失败",
      failure: { kind: "response_read" },
    };
  }
  if (!record) {
    return {
      error: "Seedance 视频上游响应不是有效 JSON",
      failure: { kind: "response_parse" },
    };
  }
  return parseSubmission(record);
}

export async function pollSeedanceVideoRequest(input: {
  adapter: ApiUpstreamAdapterDraft;
  apiKey: string | null;
  upstreamJobId: string;
  signal?: AbortSignal;
}): Promise<SeedanceVideoPollResult> {
  let response: Response;
  try {
    response = await fetchMediaUpstream(
      createSeedanceQueryUrl(input.adapter.baseUrl, input.upstreamJobId),
      {
        method: "GET",
        headers: authHeaders(input.adapter, input.apiKey),
        signal: input.signal,
        maxResponseBytes: MAX_SEEDANCE_RESPONSE_BYTES,
      }
    );
  } catch (error) {
    throw new ApiAcceptedVideoError(
      error instanceof Error ? error.message : "Seedance 视频查询失败",
      true
    );
  }
  if (!response.ok) {
    throw new ApiAcceptedVideoError(
      `Seedance 视频查询返回 HTTP ${response.status}`,
      response.status === 408 ||
        response.status === 409 ||
        response.status === 401 ||
        response.status === 403 ||
        response.status === 429 ||
        response.status >= 500,
      response.status
    );
  }
  let record: Record<string, unknown> | null;
  try {
    record = await readJson(response);
  } catch {
    throw new ApiAcceptedVideoError("Seedance 视频查询响应读取失败", true);
  }
  if (!record)
    throw new ApiAcceptedVideoError("Seedance 视频查询响应不是有效 JSON", true);
  return parsePoll(record);
}
