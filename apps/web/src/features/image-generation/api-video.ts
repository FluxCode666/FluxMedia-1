/**
 * API 账号的视频兼容协议适配器。
 *
 * 职责：把平台真实视频模型与独立参数发送到上游 `/videos/generations`，解析持久
 * 任务身份，随后按原 API 账号轮询并下载产物。使用方是视频持久状态机；本模块不
 * 负责账号调度、计费、数据库状态推进或对象存储。
 */
import { applyRequestParameterMappings } from "@repo/shared/image-backend/request-parameter-mapping";

import {
  fetchMediaUpstream,
  fetchMediaUpstreamDownloadWithTrustedOrigin,
  fetchPublicMediaUpstream,
  MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES,
} from "@/features/image-backend-pool/media-upstream-fetch";
import { parseMediaUpstreamUrl } from "@/features/image-backend-pool/media-upstream-url";

import { ApiAcceptedVideoError } from "./api-video-error";
import type { ApiConfig } from "./types";

const MAX_API_VIDEO_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_API_VIDEO_INLINE_INPUT_BYTES = 64 * 1024 * 1024;

/** API 视频适配器消费的一张已验证输入图。 */
export type ApiVideoSourceImage = {
  data: Buffer;
  type: string;
};

/** API 视频适配器消费的具名输入图集合。 */
export type ApiVideoSourceInputs = {
  firstFrame?: ApiVideoSourceImage;
  lastFrame?: ApiVideoSourceImage;
  referenceImages?: ApiVideoSourceImage[];
};

/** API 上游接受视频任务后返回的固定恢复身份。 */
export type ApiVideoSubmission = {
  pollUrl: string;
  upstreamJobId: string;
  raw: Record<string, unknown>;
};

/** API 视频提交阶段错误；字段语义与持久状态机的 Adobe 适配器一致。 */
export type ApiVideoStageError = {
  error: string;
  switchable: boolean;
  upstreamAccepted: boolean;
  terminal: boolean;
  submissionUncertain: boolean;
};

/** API 视频单次轮询结果。 */
export type ApiVideoPollResult =
  | { status: "pending"; raw: Record<string, unknown> }
  | {
      status: "completed";
      videoUrl: string;
      raw: Record<string, unknown>;
    };

/** 已接受任务从提交时快照恢复的网络信任边界。 */
export type ApiVideoRecoveryContext = {
  trustedOrigin: string;
  signal?: AbortSignal;
};

/** 判断未知 JSON 值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 从响应记录按别名读取第一个非空字符串。 */
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

/** 提取兼容响应中的任务主体；允许平台常见的 `{ data: {...} }` 包装。 */
function getResponseRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.data) ? value.data : value;
}

/** 从受限响应正文解析 JSON 记录；原始正文不得进入持久错误或用户反馈。 */
async function readJsonRecord(
  response: Response
): Promise<Record<string, unknown> | null> {
  const rawText = await response.text();
  if (!rawText.trim()) return null;
  try {
    return getResponseRecord(JSON.parse(rawText));
  } catch {
    return null;
  }
}

/** 将不受信任的上游错误收敛为只含状态码的稳定消息。 */
function getApiVideoErrorMessage(response: Response): string {
  return `视频上游返回 HTTP ${response.status}`;
}

/** 连接平台约定的视频路径，不修改管理员配置的 Base URL 前缀。 */
function appendVideoPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** 解析上游返回的绝对或相对恢复 URL，并只允许 HTTP(S)。 */
function resolveApiVideoUrl(baseUrl: string, value: string): string {
  const resolved = new URL(value, `${baseUrl.replace(/\/+$/, "")}/`);
  return parseMediaUpstreamUrl(resolved.toString()).toString();
}

/** 仅在状态 URL 与账号 Base URL 同源时携带该账号 API Key。 */
function getApiVideoHeaders(
  config: ApiConfig,
  targetUrl: string,
  trustedOrigin: string
) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (
    parseMediaUpstreamUrl(targetUrl).origin === trustedOrigin &&
    parseMediaUpstreamUrl(config.baseUrl).origin === trustedOrigin
  ) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

/** 把已验证输入图转换为平台视频 API 接受的 data URL。 */
function toDataUrl(image: ApiVideoSourceImage): string {
  return `data:${image.type};base64,${image.data.toString("base64")}`;
}

/** 估算一张输入图转换为 data URL 后的 UTF-8 字节数，不提前分配 base64 字符串。 */
function getDataUrlByteLength(image: ApiVideoSourceImage): number {
  return (
    Buffer.byteLength(`data:${image.type};base64,`) +
    4 * Math.ceil(image.data.byteLength / 3)
  );
}

/** 计算 API JSON 请求中全部内联输入图的编码后字节预算。 */
function getInlineInputByteLength(inputs: ApiVideoSourceInputs): number {
  return [
    ...(inputs.firstFrame ? [inputs.firstFrame] : []),
    ...(inputs.lastFrame ? [inputs.lastFrame] : []),
    ...(inputs.referenceImages ?? []),
  ].reduce((total, image) => total + getDataUrlByteLength(image), 0);
}

/**
 * 向一个已获租 API 账号提交视频任务。
 *
 * @param config - API 账号运行时配置与参数映射。
 * @param params - 真实模型 ID、独立生成参数、幂等键和具名输入图。
 * @returns 上游任务恢复身份，或可供调度器分类的提交错误。
 * @sideEffects 发起一次带账号 API Key 的上游 POST。
 * @failure 网络、超时、5xx 或成功但缺少任务 ID 时标记 submissionUncertain，禁止盲目重投。
 */
export async function submitApiVideoRequest(
  config: ApiConfig,
  params: {
    clientRequestId: string;
    prompt: string;
    model: string;
    duration: number;
    aspectRatio: string;
    resolution: string;
    effectiveAudio: boolean;
    negativePrompt?: string | null;
    signal?: AbortSignal;
  } & ApiVideoSourceInputs
): Promise<ApiVideoSubmission | ApiVideoStageError> {
  if (getInlineInputByteLength(params) > MAX_API_VIDEO_INLINE_INPUT_BYTES) {
    return {
      error: "API 视频内联输入超过 64 MB 上限",
      switchable: false,
      upstreamAccepted: false,
      terminal: true,
      submissionUncertain: false,
    };
  }
  const requestUrl = appendVideoPath(config.baseUrl, "videos/generations");
  const standardBody: Record<string, unknown> = {
    client_request_id: params.clientRequestId,
    prompt: params.prompt,
    model: params.model,
    duration: params.duration,
    aspect_ratio: params.aspectRatio,
    resolution: params.resolution,
    generate_audio: params.effectiveAudio,
    ...(params.negativePrompt != null
      ? { negative_prompt: params.negativePrompt }
      : {}),
    ...(params.firstFrame ? { first_frame: toDataUrl(params.firstFrame) } : {}),
    ...(params.lastFrame ? { last_frame: toDataUrl(params.lastFrame) } : {}),
    ...(params.referenceImages?.length
      ? { reference_images: params.referenceImages.map(toDataUrl) }
      : {}),
  };
  const body = applyRequestParameterMappings(
    standardBody,
    config.backend?.parameterMappings
  );
  let response: Response;
  try {
    response = await fetchMediaUpstream(requestUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: params.signal,
      maxResponseBytes: MAX_API_VIDEO_RESPONSE_BYTES,
    });
  } catch {
    return {
      error: "API 视频提交网络错误",
      switchable: false,
      upstreamAccepted: false,
      terminal: false,
      submissionUncertain: true,
    };
  }
  if (!response.ok) {
    const submissionUncertain =
      response.status === 408 ||
      response.status === 409 ||
      response.status >= 500;
    return {
      error: getApiVideoErrorMessage(response),
      switchable:
        !submissionUncertain && [401, 403, 429].includes(response.status),
      upstreamAccepted: false,
      terminal:
        !submissionUncertain && ![401, 403, 429].includes(response.status),
      submissionUncertain,
    };
  }
  let record: Record<string, unknown> | null;
  try {
    record = await readJsonRecord(response);
  } catch {
    return {
      error: "API 视频提交成功但响应读取失败",
      switchable: false,
      upstreamAccepted: false,
      terminal: false,
      submissionUncertain: true,
    };
  }
  if (!record) {
    return {
      error: "API 视频提交成功但响应不是有效 JSON",
      switchable: false,
      upstreamAccepted: false,
      terminal: false,
      submissionUncertain: true,
    };
  }
  const upstreamJobId = readString(record, ["task_id", "id", "generation_id"]);
  if (!upstreamJobId) {
    return {
      error: "API 视频提交成功但响应缺少任务 ID",
      switchable: false,
      upstreamAccepted: false,
      terminal: false,
      submissionUncertain: true,
    };
  }
  const rawPollUrl = readString(record, ["poll_url", "status_url"]);
  let pollUrl: string;
  try {
    pollUrl = rawPollUrl
      ? resolveApiVideoUrl(config.baseUrl, rawPollUrl)
      : appendVideoPath(
          config.baseUrl,
          `videos/${encodeURIComponent(upstreamJobId)}`
        );
  } catch {
    return {
      error: "API 视频提交成功但恢复地址无效",
      switchable: false,
      upstreamAccepted: true,
      terminal: false,
      submissionUncertain: true,
    };
  }
  return { pollUrl, upstreamJobId, raw: record };
}

/**
 * 轮询一个已经由 API 账号接受的视频任务。
 *
 * @param config - 原 API 账号当前运行时凭据。
 * @param pollUrl - 提交阶段持久化的状态 URL。
 * @param context - 提交时固定的可信源与可选取消信号。
 * @returns pending 或包含视频 URL 的 completed。
 * @sideEffects 发起一次 GET；跨源状态 URL 不携带账号 API Key。
 * @throws ApiAcceptedVideoError 供 worker 区分暂时错误与明确失败。
 */
export async function pollApiVideoRequest(
  config: ApiConfig,
  pollUrl: string,
  context: ApiVideoRecoveryContext
): Promise<ApiVideoPollResult> {
  let response: Response;
  try {
    const targetUrl = parseMediaUpstreamUrl(pollUrl).toString();
    const trustedOrigin = parseMediaUpstreamUrl(context.trustedOrigin).origin;
    const sameOrigin =
      parseMediaUpstreamUrl(targetUrl).origin === trustedOrigin;
    response = await (sameOrigin
      ? fetchMediaUpstream
      : fetchPublicMediaUpstream)(targetUrl, {
      method: "GET",
      headers: getApiVideoHeaders(config, targetUrl, trustedOrigin),
      signal: context.signal,
      maxResponseBytes: MAX_API_VIDEO_RESPONSE_BYTES,
    });
  } catch {
    throw new ApiAcceptedVideoError("API 视频状态查询网络错误", true);
  }
  if (!response.ok) {
    throw new ApiAcceptedVideoError(
      getApiVideoErrorMessage(response),
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
    record = await readJsonRecord(response);
  } catch {
    throw new ApiAcceptedVideoError("API 视频状态响应读取失败", true);
  }
  if (!record) {
    throw new ApiAcceptedVideoError("API 视频状态响应不是有效 JSON", true);
  }
  const status = readString(record, ["status", "state"])?.toLowerCase();
  const videoUrl = readString(record, ["video_url", "url", "output_url"]);
  if (
    status &&
    ["failed", "error", "cancelled", "canceled", "rejected"].includes(status)
  ) {
    throw new ApiAcceptedVideoError("API 视频任务失败", false);
  }
  if (
    videoUrl &&
    (!status || ["completed", "succeeded", "success", "done"].includes(status))
  ) {
    try {
      return {
        status: "completed",
        videoUrl: resolveApiVideoUrl(config.baseUrl, videoUrl),
        raw: record,
      };
    } catch {
      throw new ApiAcceptedVideoError("API 视频结果地址无效", true);
    }
  }
  if (
    !status ||
    [
      "pending",
      "queued",
      "created",
      "submitting",
      "processing",
      "running",
      "in_progress",
    ].includes(status)
  ) {
    return { status: "pending", raw: record };
  }
  throw new ApiAcceptedVideoError("API 视频任务返回未知状态", true);
}

/**
 * 下载 API 视频产物。
 *
 * @param videoUrl - 已验证的上游产物 URL。
 * @param context - 提交时固定的可信源与可选取消信号。
 * @returns 不超过 512 MiB 的视频字节。
 * @sideEffects 发起不携带账号凭据的逐跳下载；跨源目标只允许公网地址。
 * @throws ApiAcceptedVideoError 网络、边界或 HTTP 失败时携带稳定重试分类。
 */
export async function downloadApiVideoRequest(
  videoUrl: string,
  context: ApiVideoRecoveryContext
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchMediaUpstreamDownloadWithTrustedOrigin(
      videoUrl,
      context.trustedOrigin,
      {
        signal: context.signal,
        maxResponseBytes: MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES,
      }
    );
  } catch {
    throw new ApiAcceptedVideoError("API 视频下载网络错误", true);
  }
  if (!response.ok) {
    throw new ApiAcceptedVideoError(
      `API 视频下载返回 HTTP ${response.status}`,
      response.status === 408 ||
        response.status === 429 ||
        response.status >= 500,
      response.status
    );
  }
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch {
    throw new ApiAcceptedVideoError("API 视频下载响应读取失败", true);
  }
}
