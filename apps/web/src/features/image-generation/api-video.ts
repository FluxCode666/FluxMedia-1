/**
 * API 账号的视频六操作协议适配器。
 *
 * 职责：把平台视频请求交给固定版本的 `videos.generate` / `videos.query`
 * 执行器，解析同步或异步标准结果，并下载最终产物。使用方是视频持久状态机；本
 * 模块不负责账号调度、计费、数据库状态推进或对象存储。
 */
import { resolveApiUpstreamModelId } from "@repo/shared/image-backend/api-upstream-adaptation";
import type {
  ApiUpstreamRequestSnapshot,
  ApiUpstreamResponseResult,
} from "@repo/shared/image-backend/api-upstream-script-contract";

import {
  ApiUpstreamExecutionError,
  countsTowardApiUpstreamAdapterFailure,
  executeApiUpstreamOperation,
} from "@/features/image-backend-pool/api-upstream-executor";
import { createApiUpstreamOpaqueToken } from "@/features/image-backend-pool/api-upstream-opaque-values";
import { parseApiUpstreamRetryAfterSeconds } from "@/features/image-backend-pool/api-upstream-response";
import {
  fetchMediaUpstreamDownloadWithTrustedOrigin,
  MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES,
} from "@/features/image-backend-pool/media-upstream-fetch";
import { parseMediaUpstreamUrl } from "@/features/image-backend-pool/media-upstream-url";

import { ApiAcceptedVideoError } from "./api-video-error";
import type { ApiConfig } from "./types";

const MAX_API_VIDEO_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_API_VIDEO_UPSTREAM_ERROR_DETAIL_CHARACTERS = 512;
const API_VIDEO_SIGNED_INPUT_URL_TTL_SECONDS = 60 * 60;

/** API 视频适配器消费的一张已验证输入图。 */
export type ApiVideoSourceImage = {
  data: Buffer;
  type: string;
  storageKey?: string;
  storageBucket?: string;
};

/** API 视频适配器消费的具名输入图集合。 */
export type ApiVideoSourceInputs = {
  firstFrame?: ApiVideoSourceImage;
  lastFrame?: ApiVideoSourceImage;
  referenceImages?: ApiVideoSourceImage[];
};

/** API 上游生成操作的同步或异步标准结果。 */
export type ApiVideoSubmission =
  | {
      status: "pending";
      upstreamJobId: string;
      pollAfterSeconds?: number;
      raw: Record<string, unknown>;
    }
  | {
      status: "completed";
      videoUrl: string;
      raw: Record<string, unknown>;
    };

/** API 视频提交阶段错误；字段语义与持久状态机的 Adobe 适配器一致。 */
export type ApiVideoStageError = {
  error: string;
  failure: {
    kind?:
      | "timeout"
      | "network"
      | "response_read"
      | "response_parse"
      | "missing_task_id"
      | "unknown";
    statusCode?: number;
    scriptedCategory?: Extract<
      ApiUpstreamResponseResult,
      { status: "failed" }
    >["error"]["category"];
    scriptedRetryable?: boolean;
  };
  retryAfterSeconds?: number;
  /** 平台脚本容量错误不得影响供应商账号健康。 */
  backendHealthNeutral?: boolean;
};

/** API 视频单次轮询结果。 */
export type ApiVideoPollResult =
  | {
      status: "pending";
      pollAfterSeconds?: number;
      raw: Record<string, unknown>;
    }
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

/** 清洗上游错误详情，避免控制字符、凭据或过长正文进入任务错误。 */
function sanitizeApiVideoUpstreamErrorDetail(
  value: unknown
): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutControlCharacters = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
  const normalized = withoutControlCharacters
    .replace(/\s+/gu, " ")
    .replace(/bearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[a-z0-9_-]+\b/giu, "[REDACTED]")
    .replace(
      /(api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;，；。]+/giu,
      "$1=[REDACTED]"
    )
    .trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_API_VIDEO_UPSTREAM_ERROR_DETAIL_CHARACTERS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_API_VIDEO_UPSTREAM_ERROR_DETAIL_CHARACTERS - 3)}...`;
}

/** 从内置查询响应提取可安全展示的上游失败原因。 */
function getApiVideoUpstreamFailureMessage(
  record: Record<string, unknown>
): string {
  const error = isRecord(record.error) ? record.error : undefined;
  const detail = sanitizeApiVideoUpstreamErrorDetail(
    error?.message ?? record.error_message
  );
  if (detail) return `API 视频任务失败：${detail}`;

  const code = sanitizeApiVideoUpstreamErrorDetail(
    error?.code ?? record.error_code
  );
  if (code) return `API 视频任务失败（${code}）`;
  return "API 视频任务失败";
}

/** 解析上游返回的绝对或相对产物 URL，并只允许 HTTP(S)。 */
function resolveApiVideoUrl(baseUrl: string, value: string): string {
  const resolved = new URL(value, `${baseUrl.replace(/\/+$/, "")}/`);
  return parseMediaUpstreamUrl(resolved.toString()).toString();
}

/** 读取租约或任务固定的完整六操作配置。 */
function getApiUpstreamAdapter(config: ApiConfig) {
  const adapter = config.backend?.apiUpstreamAdapter;
  if (!adapter) throw new Error("API 视频账号缺少固定适配版本");
  return adapter;
}

/** 把脚本标准结果转换为不会携带原始响应正文的记录。 */
function responseResultToRecord(
  result: ApiUpstreamResponseResult
): Record<string, unknown> {
  return result as unknown as Record<string, unknown>;
}

/** 为 API 类型视频供应商签发对象存储 HTTPS 读取地址。 */
async function createSignedApiVideoInputUrl(
  image: ApiVideoSourceImage,
  storage: {
    bucketName: string;
    provider: {
      getSignedUrl(
        key: string,
        bucket: string,
        expiresIn: number
      ): Promise<string>;
    };
  }
): Promise<string> {
  if (!image.storageKey || !image.storageBucket) {
    throw new Error("API 视频 URL 输入缺少对象存储引用");
  }
  if (storage.bucketName !== image.storageBucket) {
    throw new Error("API 视频 URL 输入与当前对象存储桶不一致");
  }
  const signedUrl = await storage.provider.getSignedUrl(
    image.storageKey,
    image.storageBucket,
    API_VIDEO_SIGNED_INPUT_URL_TTL_SECONDS
  );
  const parsed = parseMediaUpstreamUrl(signedUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("API 视频 URL 输入必须使用 HTTPS");
  }
  return parsed.toString();
}

/** 将执行器阶段错误转换为视频提交状态机的安全分类。 */
function toApiVideoStageError(
  error: unknown,
  signal?: AbortSignal
): ApiVideoStageError {
  if (error instanceof ApiUpstreamExecutionError) {
    const kind =
      signal?.aborted || error.cause instanceof DOMException
        ? "timeout"
        : error.code === "response_read_failed"
          ? "response_read"
          : error.code === "transport_failed"
            ? "network"
            : "unknown";
    return {
      error: error.message,
      failure: { kind },
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      ...(error.code === "platform_busy" ? { backendHealthNeutral: true } : {}),
    };
  }
  return {
    error: "供应商请求处理失败，请联系管理员",
    failure: { kind: "unknown" },
  };
}

/** 将脚本显式返回的失败分类转换为生成阶段结论。 */
function toScriptedGenerationFailure(
  result: Extract<ApiUpstreamResponseResult, { status: "failed" }>
): ApiVideoStageError {
  // WHY：409 可能表示上游已创建任务；只有受控脚本明确标记可重试时才允许自动恢复。
  // 其他失败由状态机按 HTTP 与脚本分类执行同账号重试、切号或终止退款。
  const switchable = result.retryable;
  return {
    error: "视频上游拒绝了生成请求",
    failure: {
      scriptedCategory: result.error.category,
      scriptedRetryable: switchable,
    },
  };
}

/** 将脚本标准化生成结果收敛为视频提交结果。 */
function parseScriptedVideoSubmission(
  config: ApiConfig,
  result: ApiUpstreamResponseResult,
  pollAfterSeconds?: number,
  statusCode?: number
): ApiVideoSubmission | ApiVideoStageError {
  if (result.status === "failed") {
    const failure = toScriptedGenerationFailure(result);
    return {
      ...failure,
      failure: {
        ...failure.failure,
        ...(statusCode !== undefined ? { statusCode } : {}),
      },
    };
  }
  const raw = responseResultToRecord(result);
  if (result.status === "completed") {
    const output = result.outputs[0];
    if (output?.kind !== "video") {
      return {
        error: "供应商请求处理失败，请联系管理员",
        failure: { kind: "missing_task_id" },
      };
    }
    return {
      status: "completed",
      videoUrl: resolveApiVideoUrl(config.baseUrl, output.url),
      raw,
    };
  }
  if (!result.taskId) {
    return {
      error: "供应商请求处理失败，请联系管理员",
      failure: { kind: "missing_task_id" },
    };
  }
  return {
    status: "pending",
    upstreamJobId: result.taskId,
    pollAfterSeconds,
    raw,
  };
}

/** 将内置视频协议生成响应解析为同步或异步结果。 */
async function parseBuiltInVideoSubmission(
  config: ApiConfig,
  response: Response
): Promise<ApiVideoSubmission | ApiVideoStageError> {
  if (!response.ok) {
    const retryAfterSeconds = parseApiUpstreamRetryAfterSeconds(
      response.headers.get("retry-after"),
      new Date()
    );
    return {
      error: getApiVideoErrorMessage(response),
      failure: { statusCode: response.status },
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
  let record: Record<string, unknown> | null;
  try {
    record = await readJsonRecord(response);
  } catch {
    return {
      error: "API 视频提交成功但响应读取失败",
      failure: { kind: "response_read" },
    };
  }
  if (!record) {
    return {
      error: "API 视频提交成功但响应不是有效 JSON",
      failure: { kind: "response_parse" },
    };
  }
  const videoUrl = readString(record, ["video_url", "url", "output_url"]);
  const status = readString(record, ["status", "state"])?.toLowerCase();
  if (
    videoUrl &&
    (!status || ["completed", "succeeded", "success", "done"].includes(status))
  ) {
    return {
      status: "completed",
      videoUrl: resolveApiVideoUrl(config.baseUrl, videoUrl),
      raw: record,
    };
  }
  const upstreamJobId = readString(record, ["task_id", "id", "generation_id"]);
  if (!upstreamJobId) {
    return {
      error: "API 视频提交成功但响应缺少任务 ID",
      failure: { kind: "missing_task_id" },
    };
  }
  return {
    status: "pending",
    upstreamJobId,
    raw: record,
  };
}

/**
 * 向一个已获租 API 账号提交视频任务。
 *
 * @param config API 账号当前密钥与固定适配版本。
 * @param params 真实模型 ID、独立生成参数、幂等键和具名输入图。
 * @returns 同步产物、异步任务身份，或可供调度器分类的提交错误。
 * @sideEffects 请求脚本成功后最多发起一次供应商 POST。
 * @failure 创建失败由状态机有界重试或切号；409 仅在脚本明确可重试时自动恢复。
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
    requestId?: string;
    onBeforeSend?: () => Promise<void> | void;
    onRequestSnapshot?: (
      snapshot: ApiUpstreamRequestSnapshot
    ) => Promise<void> | void;
    signal?: AbortSignal;
  } & ApiVideoSourceInputs
): Promise<ApiVideoSubmission | ApiVideoStageError> {
  let adapter: ReturnType<typeof getApiUpstreamAdapter>;
  try {
    adapter = getApiUpstreamAdapter(config);
  } catch (error) {
    return toApiVideoStageError(error, params.signal);
  }
  const upstreamModel = resolveApiUpstreamModelId(
    params.model,
    adapter.modelMappings
  );
  let firstFrameValue: string | undefined;
  let lastFrameValue: string | undefined;
  let referenceImageValues: string[] | undefined;
  try {
    const hasSourceInputs = Boolean(
      params.firstFrame || params.lastFrame || params.referenceImages?.length
    );
    const storage = hasSourceInputs
      ? await import("@repo/shared/storage/providers").then((module) =>
          module.getStorageRuntimeSnapshot()
        )
      : undefined;
    const resolveInputValue = async (
      image: ApiVideoSourceImage
    ): Promise<string> => {
      if (!storage) throw new Error("API 视频输入缺少对象存储快照");
      return createSignedApiVideoInputUrl(image, storage);
    };
    firstFrameValue = params.firstFrame
      ? await resolveInputValue(params.firstFrame)
      : undefined;
    lastFrameValue = params.lastFrame
      ? await resolveInputValue(params.lastFrame)
      : undefined;
    referenceImageValues = params.referenceImages?.length
      ? await Promise.all(params.referenceImages.map(resolveInputValue))
      : undefined;
  } catch {
    return {
      error: "API 视频参考素材 URL 签发失败，请稍后重试",
      failure: { kind: "unknown" },
      backendHealthNeutral: true,
    };
  }

  const opaqueValues = new Map<string, unknown>();
  const toOpaqueInputValue = (value: string): string => {
    const token = createApiUpstreamOpaqueToken();
    opaqueValues.set(token, value);
    return token;
  };
  const standardBody: Record<string, unknown> = {
    client_request_id: params.clientRequestId,
    prompt: params.prompt,
    model: upstreamModel,
    duration: params.duration,
    aspect_ratio: params.aspectRatio,
    resolution: params.resolution,
    generate_audio: params.effectiveAudio,
    ...(params.negativePrompt != null
      ? { negative_prompt: params.negativePrompt }
      : {}),
    ...(firstFrameValue
      ? { first_frame: toOpaqueInputValue(firstFrameValue) }
      : {}),
    ...(lastFrameValue
      ? { last_frame: toOpaqueInputValue(lastFrameValue) }
      : {}),
    ...(referenceImageValues?.length
      ? { reference_images: referenceImageValues.map(toOpaqueInputValue) }
      : {}),
  };

  try {
    const executed = await executeApiUpstreamOperation({
      adapter,
      apiKey: config.apiKey,
      operation: "videos.generate",
      platformModelId: params.model,
      upstreamModelId: upstreamModel,
      contentType: "application/json",
      body: standardBody,
      opaqueValues,
      onRequestSnapshot: params.onRequestSnapshot,
      onBeforeSend: params.onBeforeSend,
      signal: params.signal,
      requestId: params.requestId,
      maxResponseBytes: MAX_API_VIDEO_RESPONSE_BYTES,
      observability: {
        memberId: config.backend?.id,
        groupId: config.backend?.groupId,
      },
    });
    return executed.kind === "scripted"
      ? parseScriptedVideoSubmission(
          config,
          executed.result,
          executed.pollAfterSeconds,
          executed.response.status
        )
      : await parseBuiltInVideoSubmission(config, executed.response);
  } catch (error) {
    return toApiVideoStageError(error, params.signal);
  }
}

/** 将脚本标准化查询结果收敛为轮询结果。 */
function parseScriptedVideoPollResult(
  config: ApiConfig,
  result: ApiUpstreamResponseResult,
  pollAfterSeconds?: number
): ApiVideoPollResult {
  if (result.status === "failed") {
    throw new ApiAcceptedVideoError("API 视频任务失败", false);
  }
  const raw = responseResultToRecord(result);
  if (result.status !== "completed") {
    return { status: "pending", pollAfterSeconds, raw };
  }
  const output = result.outputs[0];
  if (output?.kind !== "video") {
    throw new ApiAcceptedVideoError(
      "供应商请求处理失败，请联系管理员",
      true,
      undefined,
      true
    );
  }
  return {
    status: "completed",
    videoUrl: resolveApiVideoUrl(config.baseUrl, output.url),
    raw,
  };
}

/** 将内置视频协议查询响应解析为轮询结果。 */
async function parseBuiltInVideoPollResult(
  config: ApiConfig,
  response: Response
): Promise<ApiVideoPollResult> {
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
    throw new ApiAcceptedVideoError(
      "API 视频状态响应读取失败",
      true,
      undefined,
      true
    );
  }
  if (!record) {
    throw new ApiAcceptedVideoError(
      "API 视频状态响应不是有效 JSON",
      true,
      undefined,
      true
    );
  }
  const status = readString(record, ["status", "state"])?.toLowerCase();
  const videoUrl = readString(record, ["video_url", "url", "output_url"]);
  if (
    status &&
    ["failed", "error", "cancelled", "canceled", "rejected"].includes(status)
  ) {
    throw new ApiAcceptedVideoError(
      getApiVideoUpstreamFailureMessage(record),
      false
    );
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
      throw new ApiAcceptedVideoError(
        "API 视频结果地址无效",
        true,
        undefined,
        true
      );
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
  throw new ApiAcceptedVideoError(
    "API 视频任务返回未知状态",
    true,
    undefined,
    true
  );
}

/**
 * 轮询一个已经由 API 账号接受的视频任务。
 *
 * @param config 原 API 账号当前密钥和任务固定的适配版本。
 * @param upstreamJobId 提交阶段持久化的上游任务 ID。
 * @param context 提交时固定的可信源与可选取消信号。
 * @returns pending 或包含视频 URL 的 completed。
 * @sideEffects 只按固定 `videos.query` 路径发起一次 GET。
 * @throws ApiAcceptedVideoError 供 worker 区分任务失败与连续适配执行失败。
 */
export async function pollApiVideoRequest(
  config: ApiConfig,
  upstreamJobId: string,
  context: ApiVideoRecoveryContext
): Promise<ApiVideoPollResult> {
  let adapter: ReturnType<typeof getApiUpstreamAdapter>;
  try {
    adapter = getApiUpstreamAdapter(config);
    const fixedOrigin = parseMediaUpstreamUrl(adapter.baseUrl).origin;
    if (fixedOrigin !== parseMediaUpstreamUrl(context.trustedOrigin).origin) {
      throw new Error("API 视频恢复的固定适配版本与可信源不一致");
    }
  } catch (error) {
    throw new ApiAcceptedVideoError(
      "供应商请求处理失败，请联系管理员",
      true,
      undefined,
      true,
      { cause: error }
    );
  }
  const upstreamModel = resolveApiUpstreamModelId(
    config.model ?? "unknown-video-model",
    adapter.modelMappings
  );
  try {
    const executed = await executeApiUpstreamOperation({
      adapter,
      apiKey: config.apiKey,
      operation: "videos.query",
      platformModelId: config.model ?? upstreamModel,
      upstreamModelId: upstreamModel,
      contentType: "application/json",
      taskId: upstreamJobId,
      signal: context.signal,
      maxResponseBytes: MAX_API_VIDEO_RESPONSE_BYTES,
      observability: {
        memberId: config.backend?.id,
        groupId: config.backend?.groupId,
      },
    });
    return executed.kind === "scripted"
      ? parseScriptedVideoPollResult(
          config,
          executed.result,
          executed.pollAfterSeconds
        )
      : await parseBuiltInVideoPollResult(config, executed.response);
  } catch (error) {
    if (error instanceof ApiAcceptedVideoError) throw error;
    if (error instanceof ApiUpstreamExecutionError) {
      // WHY：容量饱和与传输异常不代表管理员适配配置损坏，不能消耗连续三次
      // 适配失败预算；否则短暂平台拥塞可能让已接受任务提前失败退款。
      throw new ApiAcceptedVideoError(
        error.message,
        true,
        undefined,
        countsTowardApiUpstreamAdapterFailure(error),
        { cause: error }
      );
    }
    throw new ApiAcceptedVideoError(
      "供应商请求处理失败，请联系管理员",
      true,
      undefined,
      true,
      { cause: error }
    );
  }
}

/**
 * 下载 API 视频产物。
 *
 * @param videoUrl 已验证的上游产物 URL。
 * @param context 提交时固定的可信源与可选取消信号。
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
