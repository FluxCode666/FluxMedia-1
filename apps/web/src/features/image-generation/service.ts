/**
 * 单张图片上游适配与后端池重试服务。
 *
 * 使用方：`operations.ts` 的统一图片管线、后端测活与 Adobe 视频配置解析。
 * 本文件保留 Images API、Adobe gateway/direct、输入图转存和通用图片 SSE 解析。
 */
import {
  buildAdobeImageRequestBody,
  canAdobeBackendServeModel,
  isAdobeImageFamilyModelId,
  parseAdobeMediaResult,
  pickExplicitAdobeImageFamily,
} from "@repo/shared/adobe";
import {
  type ApiUpstreamAdapterDraft,
  resolveApiUpstreamModelId,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS,
  type ApiUpstreamAdapterOperationId,
  type ApiUpstreamResponseResult,
} from "@repo/shared/image-backend/api-upstream-script-contract";
import { logError } from "@repo/shared/logger";
import {
  ApiUpstreamExecutionError,
  type ApiUpstreamExecutionResult,
  ApiUpstreamRequestScriptOutputError,
  countsTowardApiUpstreamAdapterFailure,
  executeApiUpstreamOperation,
} from "@/features/image-backend-pool/api-upstream-executor";
import { logApiUpstreamImageTaskOrphanRisk } from "@/features/image-backend-pool/api-upstream-observability";
import { createApiUpstreamOpaqueToken } from "@/features/image-backend-pool/api-upstream-opaque-values";
import { resolveApiUpstreamRequestUrl } from "@/features/image-backend-pool/api-upstream-path";
import { parseApiUpstreamRetryAfterSeconds } from "@/features/image-backend-pool/api-upstream-response";
import {
  fetchMediaUpstream,
  fetchMediaUpstreamDownload,
} from "@/features/image-backend-pool/media-upstream-fetch";
import { runAdobeDirectImageRequest } from "./adobe-direct";
import { appendImagesUpstreamNonce } from "./images-upstream-nonce";
import {
  normalizeImageBackground,
  normalizeOutputCompression,
  normalizeOutputFormat,
} from "./output-format";
import { ensureInputImageRehosted } from "./rehost-input-images";
import {
  DEFAULT_IMAGE_SIZE,
  getImageBackendApiModel,
  getImageModel,
  isImageModel,
  normalizeImageModel,
  parseImageSize,
} from "./resolution";
import type {
  ApiConfig,
  EditImageParams,
  GenerateImageParams,
  GenerateImageResult,
  ImageGenerationCallbacks,
  ImageInputFile,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  PartialImageResult,
} from "./types";

const VALID_QUALITIES = new Set<ImageQuality>([
  "auto",
  "low",
  "medium",
  "high",
]);
const VALID_MODERATION = new Set<ImageModeration>(["auto", "low"]);
const MAX_MEDIA_API_RESPONSE_BYTES = 128 * 1024 * 1024;
const API_IMAGE_POLL_BUDGET_MS = 20 * 60 * 1_000;
const MAX_API_IMAGE_QUERY_FAILURES = 3;

type ImageOutput = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  index?: number;
};

type ImageResponsePayload = {
  type?: string;
  data?: ImageOutput[];
  b64_json?: string;
  partial_image_b64?: string;
  url?: string;
  revised_prompt?: string;
  index?: number;
  partial_image_index?: number;
  error?: { message?: string } | string;
  message?: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getModel(config: ApiConfig, model: string) {
  if (config.backend?.type === "pool-api") {
    return getImageBackendApiModel(model, config.model);
  }
  const requestedModel = normalizeImageModel(model);
  if (requestedModel && !isImageModel(requestedModel)) {
    if (
      config.backend?.type === "pool-adobe" &&
      isAdobeImageFamilyModelId(requestedModel)
    ) {
      return requestedModel;
    }
    throw new Error(
      "Unsupported model for image generation. Use a gpt-image-* model."
    );
  }

  const imageModel = getImageModel(requestedModel, config.model);
  if (!imageModel) {
    throw new Error(
      "Unsupported model for image generation. Use a gpt-image-* model."
    );
  }
  return imageModel;
}

function getHeaders(
  config: ApiConfig,
  defaults: Record<string, string>
): Record<string, string> {
  return {
    ...defaults,
    ...(config.headers || {}),
    Authorization: `Bearer ${config.apiKey}`,
  };
}

/** 解析 pool-api 账号实际发送的模型 ID；其他后端保持平台模型。 */
function getApiBackendUpstreamModel(
  config: ApiConfig,
  platformModelId: string
) {
  if (config.backend?.type !== "pool-api") return platformModelId;
  return resolveApiUpstreamModelId(
    platformModelId,
    config.backend.modelMappings
  );
}

/** 读取获租时固定的 API 六操作版本；缺失时禁止回退旧可变脚本。 */
function getApiUpstreamAdapter(config: ApiConfig): ApiUpstreamAdapterDraft {
  const adapter = config.backend?.apiUpstreamAdapter;
  if (!adapter) throw new Error("API 图片账号缺少固定适配版本");
  return adapter;
}

/** 向脚本请求对象追加字段并保留 multipart 重复键顺序。 */
function appendScriptRequestValue(
  request: Record<string, unknown>,
  name: string,
  value: unknown
): void {
  const existing = request[name];
  if (existing === undefined) {
    request[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    request[name] = [existing, value];
  }
}

/** 检查 multipart 脚本输出的嵌套容器中是否包含宿主媒体。 */
function containsBlob(value: unknown): boolean {
  if (value instanceof Blob) return true;
  if (Array.isArray(value)) return value.some(containsBlob);
  if (!isPlainRecord(value)) return false;
  return Object.values(value).some(containsBlob);
}

/** 把脚本输出值重新编码为 multipart 条目。 */
function appendTransformedFormDataValue(
  formData: FormData,
  name: string,
  value: unknown
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      appendTransformedFormDataValue(formData, name, item);
    }
    return;
  }
  if (value instanceof Blob) {
    const filename =
      "name" in value && typeof value.name === "string" ? value.name : null;
    if (filename) {
      formData.append(name, value, filename);
    } else {
      formData.append(name, value);
    }
    return;
  }
  if (isPlainRecord(value)) {
    formData.append(name, JSON.stringify(value));
    return;
  }
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new Error("API 账号请求处理脚本返回了非法 multipart 字段");
  }
  formData.append(name, String(value));
}

/**
 * 限制 multipart 媒体只能位于顶层字段或顶层数组元素。
 *
 * WHY：嵌套对象会被 JSON.stringify 为普通文本，若其中混入恢复后的 Blob，文件会
 * 静默变成 `{}`。失败关闭可以避免管理员脚本看似成功、实际上游收到损坏媒体。
 */
function assertMultipartMediaPlacement(value: unknown): void {
  if (value instanceof Blob) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item instanceof Blob) continue;
      if (containsBlob(item)) {
        throw new Error("API 账号请求处理脚本返回了非法 multipart 媒体位置");
      }
    }
    return;
  }
  if (containsBlob(value)) {
    throw new Error("API 账号请求处理脚本返回了非法 multipart 媒体位置");
  }
}

/**
 * 以宿主令牌隔离 multipart 文件后执行账号脚本，再恢复 Blob 并重建表单。
 */
function createApiBackendFormDataRequest(formData: FormData): {
  body: Record<string, unknown>;
  opaqueValues: Map<string, unknown>;
} {
  const request: Record<string, unknown> = {};
  const opaqueValues = new Map<string, unknown>();
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string") {
      appendScriptRequestValue(request, name, value);
      continue;
    }
    const token = createApiUpstreamOpaqueToken();
    opaqueValues.set(token, value);
    appendScriptRequestValue(request, name, token);
  }
  return { body: request, opaqueValues };
}

/** 把已恢复宿主媒体的严格顶层对象编码为 FormData。 */
function encodeApiBackendFormDataRequest(value: unknown): FormData {
  try {
    if (!isPlainRecord(value)) {
      throw new Error("API 账号请求处理脚本返回了非法 multipart 请求体");
    }
    const result = new FormData();
    for (const [name, fieldValue] of Object.entries(value)) {
      assertMultipartMediaPlacement(fieldValue);
      appendTransformedFormDataValue(result, name, fieldValue);
    }
    return result;
  } catch (error) {
    throw new ApiUpstreamRequestScriptOutputError(error);
  }
}

function getApiErrorMessage(errorData: unknown): string | null {
  if (typeof errorData === "string" && errorData.trim()) {
    return errorData.trim();
  }

  if (Array.isArray(errorData)) {
    const parts = errorData
      .map((item) => getApiErrorMessage(item))
      .filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(" | ") : null;
  }

  if (
    errorData &&
    typeof errorData === "object" &&
    "error" in errorData &&
    errorData.error
  ) {
    const nested = getApiErrorMessage(errorData.error);
    if (nested) return nested;
  }

  if (
    errorData &&
    typeof errorData === "object" &&
    "response" in errorData &&
    errorData.response
  ) {
    const nested = getApiErrorMessage(errorData.response);
    if (nested) return nested;
  }

  if (errorData && typeof errorData === "object") {
    const record = errorData as Record<string, unknown>;
    const parts = [
      record.message,
      record.detail,
      record.details,
      record.code,
      record.type,
      record.status,
    ]
      .flatMap((value) => {
        if (typeof value === "string" && value.trim()) return [value.trim()];
        if (typeof value === "number" && Number.isFinite(value)) {
          return [String(value)];
        }
        const nested = getApiErrorMessage(value);
        return nested ? [nested] : [];
      })
      .filter(Boolean);
    if (parts.length) return parts.join(" | ");
  }

  return null;
}

function getHeaderValue(headers: Headers, names: string[]) {
  for (const name of names) {
    const value = headers.get(name);
    if (value?.trim()) return value.trim();
  }
  return null;
}

function parseRetryAfterHeader(value: string | null) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const durationMs = parseDurationMs(value);
  if (durationMs) return Math.max(1, Math.ceil(durationMs / 1000));
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.max(1, Math.ceil((date.getTime() - Date.now()) / 1000));
}

function parseDurationMs(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?\s*ms$/.test(trimmed)) {
    return Number.parseFloat(trimmed) || null;
  }
  if (/^\d+(?:\.\d+)?\s*s$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 1000;
  }
  if (/^\d+(?:\.\d+)?\s*m$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 60_000;
  }
  if (/^\d+(?:\.\d+)?\s*h$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 60 * 60_000;
  }
  if (/^\d+(?:\.\d+)?\s*d(?:ay|ays)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 24 * 60 * 60_000;
  }
  const parts = [
    ...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|day|days)/g),
  ];
  if (!parts.length) return null;
  const total = parts.reduce((sum, match) => {
    const amount = Number.parseFloat(match[1] || "0");
    const unit = match[2];
    if (unit === "ms") return sum + amount;
    if (unit === "s") return sum + amount * 1000;
    if (unit === "m") return sum + amount * 60_000;
    if (unit === "h") return sum + amount * 60 * 60_000;
    if (unit === "d" || unit === "day" || unit === "days") {
      return sum + amount * 24 * 60 * 60_000;
    }
    return sum;
  }, 0);
  return total > 0 ? total : null;
}

function getResponseRetryMetadata(response: Response) {
  const retryAfterSeconds = parseRetryAfterHeader(
    getHeaderValue(response.headers, ["retry-after"])
  );
  const upstreamResetAt = getHeaderValue(response.headers, [
    "x-ratelimit-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset-images",
    "x-ratelimit-reset-image-requests",
    "x-ratelimit-reset-input-tokens",
    "x-ratelimit-reset-output-tokens",
  ]);
  return {
    upstreamResetAt: upstreamResetAt || undefined,
    retryAfterSeconds,
  };
}

function extractPayloadRetryMetadata(payload: unknown): {
  upstreamResetAt?: string;
  retryAfterSeconds?: number;
} {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const metadata = extractPayloadRetryMetadata(item);
      if (metadata.upstreamResetAt || metadata.retryAfterSeconds) {
        return metadata;
      }
    }
    return {};
  }
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const nested = [
    record.error,
    record.response,
    record.details,
    record.metadata,
    record.payload,
    record.data,
  ];
  const keys = [
    "resetAt",
    "reset_at",
    "resetAfter",
    "reset_after",
    "reset_after_seconds",
    "resetsAt",
    "resets_at",
    "resetsInSeconds",
    "resets_in_seconds",
    "restore_at",
    "restoreAt",
    "restoreAfter",
    "restore_after",
    "quotaResetDelay",
    "retry_at",
    "upstreamResetAt",
    "upstream_reset_at",
  ];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      if (
        /after$/i.test(key) ||
        /seconds$/i.test(key) ||
        key === "quotaResetDelay"
      ) {
        const parsed = parseRetryAfterHeader(value.trim());
        if (parsed) return { retryAfterSeconds: parsed };
      }
      return { upstreamResetAt: value.trim() };
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      if (
        /after$/i.test(key) ||
        /seconds$/i.test(key) ||
        key === "quotaResetDelay"
      ) {
        return { retryAfterSeconds: value };
      }
      return { upstreamResetAt: String(value) };
    }
  }
  const retryAfter = record.retry_after ?? record.retryAfter;
  if (
    typeof retryAfter === "number" &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0
  ) {
    return { retryAfterSeconds: retryAfter };
  }
  if (typeof retryAfter === "string" && retryAfter.trim()) {
    const parsed = parseRetryAfterHeader(retryAfter.trim());
    if (parsed) return { retryAfterSeconds: parsed };
  }
  for (const value of nested) {
    const metadata = extractPayloadRetryMetadata(value);
    if (metadata.upstreamResetAt || metadata.retryAfterSeconds) return metadata;
  }
  return {};
}

function withRetryMetadata<T extends GenerateImageResult>(
  result: T,
  metadata: { upstreamResetAt?: string; retryAfterSeconds?: number }
): T {
  if (!metadata.upstreamResetAt && !metadata.retryAfterSeconds) return result;
  return {
    ...result,
    upstreamResetAt: result.upstreamResetAt || metadata.upstreamResetAt,
    retryAfterSeconds: result.retryAfterSeconds ?? metadata.retryAfterSeconds,
  } as T;
}

function safeParseJson(value: string) {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function truncateResponseBody(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function getHttpErrorMessage(
  response: Response,
  rawBody: string,
  apiName: "Images API" | "Adobe Firefly API"
) {
  const fallback = `Upstream ${apiName} returned HTTP ${response.status}`;
  const trimmedBody = truncateResponseBody(rawBody);

  if (!trimmedBody) return fallback;
  if (trimmedBody.startsWith("<")) {
    return `${fallback}: HTML response body. Check that the API base URL points to an OpenAI-compatible /v1 endpoint.`;
  }

  let errorData: unknown = trimmedBody;
  try {
    errorData = JSON.parse(rawBody);
  } catch {
    return `${fallback}: ${trimmedBody}`;
  }

  const apiError = getApiErrorMessage(errorData);
  return apiError ? `${fallback}: ${apiError}` : `${fallback}: ${trimmedBody}`;
}

function getNonJsonErrorMessage(
  rawBody: string,
  apiName: "Images API",
  response?: Response
) {
  const trimmedBody = truncateResponseBody(rawBody);
  const statusText = response
    ? `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
    : null;
  const contentType = response?.headers.get("content-type") || "";
  const context = [statusText, contentType ? `content-type=${contentType}` : ""]
    .filter(Boolean)
    .join(", ");
  const suffix = context ? ` (${context})` : "";
  if (trimmedBody.startsWith("<")) {
    return `API returned an HTML page instead of a ${apiName} response${suffix}. Check that the API base URL points to an OpenAI-compatible /v1 endpoint.`;
  }
  if (!trimmedBody)
    return `API returned an empty non-JSON ${apiName} response${suffix}.`;
  return `API returned a non-JSON ${apiName} response${suffix}: ${trimmedBody}`;
}

function looksLikeEventStreamText(text: string) {
  return /(?:^|\n)(?:event|data):/.test(text.replace(/\r\n/g, "\n"));
}

function tryParseJsonPayloadError(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }
  return getPayloadError(safeParseJson(trimmed));
}

function withStreamJsonErrorFallback<T extends { error?: string }>(
  result: T,
  rawText: string
): T {
  if (result.error !== "API returned no image data") return result;
  const jsonError = tryParseJsonPayloadError(rawText);
  return jsonError ? ({ ...result, error: jsonError } as T) : result;
}

function normalizeQuality(quality?: string): ImageQuality | undefined {
  if (!quality || quality === "auto") return undefined;
  return VALID_QUALITIES.has(quality as ImageQuality)
    ? (quality as ImageQuality)
    : undefined;
}

function normalizeModeration(moderation?: string): ImageModeration | undefined {
  if (!moderation) return undefined;
  return VALID_MODERATION.has(moderation as ImageModeration)
    ? (moderation as ImageModeration)
    : undefined;
}

function describeEndpoint(baseUrl: string, path: string) {
  try {
    const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    return `${url.origin}${url.pathname}`;
  } catch {
    return `${baseUrl.replace(/\/$/, "")}${path}`;
  }
}

function logImageRequestError(
  error: unknown,
  context: {
    operation: "generate" | "edit";
    baseUrl: string;
    path: string;
    model?: string;
    useStream?: boolean;
  }
) {
  logError(error, {
    source: "image-generation",
    operation: context.operation,
    endpoint: describeEndpoint(context.baseUrl, context.path),
    model: context.model,
    useStream: Boolean(context.useStream),
  });
}

function toBlobPart(buffer: Buffer): BlobPart {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function applyPromptOptimizationResultVisibility(
  result: GenerateImageResult
): GenerateImageResult {
  if (result.error) return result;
  const upstreamRevisedPrompt =
    result.upstreamRevisedPrompt || result.revisedPrompt;
  if (!upstreamRevisedPrompt) return result;

  return {
    ...result,
    revisedPrompt: result.revisedPrompt || upstreamRevisedPrompt,
    upstreamRevisedPrompt,
  };
}

const MISSING_IMAGE_OUTPUT_ERROR = "Upstream returned no image output";

function hasRequiredImageOutput(result: GenerateImageResult) {
  return Boolean(
    result.imageBase64 ||
      result.imageUrl ||
      result.imageOutputs?.some((item) => item.imageBase64 || item.imageUrl)
  );
}

function requireImageOutput(result: GenerateImageResult): GenerateImageResult {
  if (result.error || hasRequiredImageOutput(result)) return result;
  return {
    ...result,
    error: MISSING_IMAGE_OUTPUT_ERROR,
  };
}

function getEffectivePrompt(params: {
  prompt: string;
  apiPrompt?: string;
  fileContext?: string;
  promptOptimization?: boolean;
}) {
  const prompt =
    params.promptOptimization === false
      ? params.prompt
      : params.apiPrompt || params.prompt;
  return params.fileContext ? `${prompt}\n\n${params.fileContext}` : prompt;
}

function appendImageParams(
  formData: FormData,
  config: ApiConfig,
  params: {
    prompt: string;
    model: string;
    n?: number;
    size?: string;
    quality?: ImageQuality;
    moderation?: ImageModeration;
    promptOptimization?: boolean;
    outputFormat?: ImageOutputFormat;
    outputCompression?: number;
    background?: string;
  }
) {
  formData.append("model", params.model);
  // multipart 改图同样注入每请求唯一零宽 nonce 破上游内容缓存（仅上游请求体）。
  formData.append("prompt", appendImagesUpstreamNonce(params.prompt));
  formData.append("n", String(params.n || 1));
  formData.append("response_format", "b64_json");

  if (params.size) {
    formData.append("size", params.size);
    const dimensions = parseImageSize(params.size);
    if (dimensions) {
      formData.append("width", String(dimensions.width));
      formData.append("height", String(dimensions.height));
    }
  }

  const quality = normalizeQuality(params.quality);
  if (quality) {
    formData.append("quality", quality);
  }

  const moderation = normalizeModeration(params.moderation);
  if (moderation) {
    formData.append("moderation", moderation);
  }

  const outputFormat = normalizeOutputFormat(params.outputFormat);
  if (outputFormat) {
    formData.append("output_format", outputFormat);
  }

  const outputCompression = normalizeOutputCompression(
    params.outputCompression
  );
  if (outputCompression !== undefined) {
    formData.append("output_compression", String(outputCompression));
  }

  const background = normalizeImageBackground(params.background);
  if (background) {
    formData.append("background", background);
  }

  if (config.useStream) {
    formData.append("stream", "true");
    formData.append("partial_images", "2");
  }
}

function toGenerateImageResult(image: ImageOutput): GenerateImageResult {
  const result: GenerateImageResult = {};
  if (image.b64_json) result.imageBase64 = image.b64_json;
  if (image.url) result.imageUrl = image.url;
  if (image.b64_json || image.url) result.imageOutputCount = 1;
  if (image.revised_prompt) {
    result.upstreamRevisedPrompt = image.revised_prompt;
  }
  if (image.b64_json || image.url) {
    result.imageOutputs = [
      {
        imageBase64: image.b64_json,
        imageUrl: image.url,
        upstreamRevisedPrompt: image.revised_prompt,
        index: typeof image.index === "number" ? image.index : 0,
      },
    ];
  }
  return result;
}

function getPayloadError(payload: unknown): string | null {
  const apiError = getApiErrorMessage(payload);
  if (apiError) return apiError;

  if (
    payload &&
    typeof payload === "object" &&
    "type" in payload &&
    payload.type === "upstream_error" &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  return null;
}

function extractImageFromPayload(
  payload: ImageResponsePayload
): GenerateImageResult | null {
  const images = (payload.data || []).filter(
    (item) => item.b64_json || item.url
  );
  const image = images.at(-1);
  if (image) {
    return toGenerateImageResult(image);
  }

  if (payload.b64_json || payload.url) {
    return toGenerateImageResult(payload);
  }

  return null;
}

function extractPartialImage(
  payload: ImageResponsePayload
): PartialImageResult | null {
  const imageBase64 = payload.b64_json || payload.partial_image_b64;
  if (!imageBase64 && !payload.url) {
    return null;
  }

  const result: PartialImageResult = {};
  if (imageBase64) result.imageBase64 = imageBase64;
  if (payload.url) result.imageUrl = payload.url;
  if (typeof payload.index === "number") result.index = payload.index;
  if (typeof payload.partial_image_index === "number") {
    result.partialImageIndex = payload.partial_image_index;
  }
  return result;
}

type EventStreamParseState = {
  completedResult: GenerateImageResult | null;
  fallbackResult: GenerateImageResult | null;
};

async function processEventPayload(
  eventName: string,
  dataLines: string[],
  state: EventStreamParseState,
  callbacks?: ImageGenerationCallbacks
) {
  if (dataLines.length === 0) return null;

  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return null;

  let payload: ImageResponsePayload;
  try {
    payload = JSON.parse(data) as ImageResponsePayload;
  } catch {
    return null;
  }

  if (eventName === "error" || payload.type === "upstream_error") {
    return getPayloadError(payload) || "Image generation stream failed";
  }

  if (
    eventName.includes("partial_image") ||
    payload.type?.includes("partial_image")
  ) {
    const partialImage = extractPartialImage(payload);
    if (partialImage) {
      await callbacks?.onPartialImage?.(partialImage);
    }
    return null;
  }

  const result = extractImageFromPayload(payload);
  if (!result) return null;

  if (
    eventName.endsWith(".completed") ||
    payload.type?.endsWith(".completed")
  ) {
    state.completedResult = result;
  } else if (!state.fallbackResult) {
    state.fallbackResult = result;
  }

  return null;
}

async function processEventBlock(
  block: string,
  state: EventStreamParseState,
  callbacks?: ImageGenerationCallbacks
) {
  let eventName = "";
  const dataLines: string[] = [];
  const lines = block.replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue =
      separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  return await processEventPayload(eventName, dataLines, state, callbacks);
}

function finishEventStream(state: EventStreamParseState): GenerateImageResult {
  const result = state.completedResult || state.fallbackResult;
  return result || { error: "API returned no image data" };
}

async function parseEventStreamText(
  text: string,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  const jsonError = tryParseJsonPayloadError(text);
  if (jsonError) return { error: jsonError };

  const state: EventStreamParseState = {
    completedResult: null,
    fallbackResult: null,
  };

  const blocks = text.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    const error = await processEventBlock(block, state, callbacks);
    if (error) return { error };
  }

  return finishEventStream(state);
}

async function parseEventStreamResponse(
  response: Response,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  if (!response.body) {
    return parseEventStreamText(await response.text(), callbacks);
  }

  const state: EventStreamParseState = {
    completedResult: null,
    fallbackResult: null,
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawText = "";

  while (true) {
    const { value, done } = await reader.read();
    const chunk = decoder.decode(value, { stream: !done });
    rawText += chunk;
    buffer += chunk;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      if (!block.trim()) continue;
      const error = await processEventBlock(block, state, callbacks);
      if (error) {
        await reader.cancel().catch(() => undefined);
        return { error };
      }
    }

    if (done) break;
  }

  if (buffer.trim()) {
    const error = await processEventBlock(buffer, state, callbacks);
    if (error) return { error };
  }

  return withStreamJsonErrorFallback(finishEventStream(state), rawText);
}

async function parseImageResponse(
  response: Response,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  const responseRetryMetadata = getResponseRetryMetadata(response);
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    return {
      error: getHttpErrorMessage(response, rawBody, "Images API"),
      ...responseRetryMetadata,
      ...extractPayloadRetryMetadata(safeParseJson(rawBody)),
    };
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    return withRetryMetadata(
      await parseEventStreamResponse(response, callbacks),
      responseRetryMetadata
    );
  }

  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    if (looksLikeEventStreamText(text)) {
      return withRetryMetadata(
        await parseEventStreamText(text, callbacks),
        responseRetryMetadata
      );
    }
    return {
      error: getNonJsonErrorMessage(text, "Images API", response),
      ...responseRetryMetadata,
    };
  }

  const data = (await response.json()) as ImageResponsePayload;
  const result = extractImageFromPayload(data);

  if (!result) {
    return withRetryMetadata(
      { error: getPayloadError(data) || "API returned no image data" },
      { ...responseRetryMetadata, ...extractPayloadRetryMetadata(data) }
    );
  }

  return withRetryMetadata(result, responseRetryMetadata);
}

type BuiltInApiImageResponse =
  | { kind: "result"; result: GenerateImageResult }
  | { kind: "pending"; taskId?: string; pollAfterSeconds?: number };

/** 从普通记录按常见别名读取首个非空字符串。 */
function readApiImageString(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * 解析脚本留空时的内置 Images 协议，兼容同步产物和常见异步任务状态。
 *
 * 上游返回的 poll_url/status_url 永不读取；宿主只保存 task ID 并使用固定查询路径。
 */
async function parseBuiltInApiImageResponse(
  response: Response,
  callbacks?: ImageGenerationCallbacks
): Promise<BuiltInApiImageResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.ok || !contentType.includes("json")) {
    return {
      kind: "result",
      result: await parseImageResponse(response, callbacks),
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      kind: "result",
      result: { error: "Images API returned invalid JSON" },
    };
  }
  const record = isPlainRecord(payload)
    ? isPlainRecord(payload.data)
      ? payload.data
      : payload
    : null;
  if (record) {
    const status = readApiImageString(record, [
      "status",
      "state",
    ])?.toLowerCase();
    if (
      status &&
      ["failed", "error", "cancelled", "canceled", "rejected"].includes(status)
    ) {
      return {
        kind: "result",
        result: { error: getPayloadError(payload) || "API 图片任务失败" },
      };
    }
    const synchronousResult = extractImageFromPayload(
      payload as ImageResponsePayload
    );
    if (synchronousResult) {
      return { kind: "result", result: synchronousResult };
    }
    const taskId = readApiImageString(record, [
      "task_id",
      "id",
      "generation_id",
    ]);
    const isPending =
      !status ||
      [
        "pending",
        "queued",
        "created",
        "submitting",
        "processing",
        "running",
        "in_progress",
      ].includes(status);
    if (isPending && (taskId || status)) {
      return {
        kind: "pending",
        taskId,
        pollAfterSeconds: parseApiUpstreamRetryAfterSeconds(
          response.headers.get("retry-after"),
          new Date()
        ),
      };
    }
  }
  const result = extractImageFromPayload(payload as ImageResponsePayload);
  return {
    kind: "result",
    result: result ?? {
      error: getPayloadError(payload) || "API returned no image data",
    },
  };
}

/** 将标准图片输出转换为现有图片管线结果，不暴露供应商原始响应。 */
function convertScriptedImageOutputs(
  result: Extract<ApiUpstreamResponseResult, { status: "completed" }>
): GenerateImageResult {
  const imageOutputs = result.outputs.flatMap((output, index) => {
    if (output.kind !== "image") return [];
    const imageBase64 =
      output.base64?.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/isu)?.[1] ??
      output.base64;
    return [
      {
        ...(imageBase64 ? { imageBase64 } : {}),
        ...(output.url ? { imageUrl: output.url } : {}),
        index,
      },
    ];
  });
  const first = imageOutputs[0];
  if (!first) {
    return {
      error: "供应商请求处理失败，请联系管理员",
      backendSwitchAllowed: false,
    };
  }
  return {
    ...first,
    imageOutputs,
    imageOutputCount: imageOutputs.length,
  };
}

/** 把响应脚本的稳定失败类别转换为现有用户与 SLA 可识别的安全消息。 */
function getScriptedImageFailureMessage(
  result: Extract<ApiUpstreamResponseResult, { status: "failed" }>
): string {
  if (result.error.category === "moderation") {
    return "Content moderation rejected the image request";
  }
  if (result.error.category === "invalid_request") {
    return "image_generation_user_error: 供应商拒绝了图片请求参数";
  }
  return "供应商图片任务失败，请联系管理员";
}

/** 可取消等待；用于供应商异步图片任务的进程内轮询。 */
async function waitForApiImagePoll(
  seconds: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("图片任务已取消"));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, seconds * 1_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
}

/** 将执行器错误映射为图片管线的切换、健康与重试事实。 */
function convertApiImageExecutionError(
  error: unknown,
  upstreamAccepted: boolean
): GenerateImageResult {
  if (error instanceof ApiUpstreamExecutionError) {
    return {
      error: error.message,
      ...(error.retryAfterSeconds
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      backendSwitchAllowed:
        error.code === "platform_busy"
          ? false
          : !upstreamAccepted && error.stage === "before_send",
      backendHealthNeutral: error.code === "platform_busy",
    };
  }
  return {
    error: "供应商请求处理失败，请联系管理员",
    backendSwitchAllowed: !upstreamAccepted,
  };
}

/**
 * 在单次请求的二十分钟业务预算内轮询已接受的供应商图片任务。
 *
 * 一旦取得 task ID，任何错误都返回 `backendSwitchAllowed=false`，从而禁止外层
 * 调度器更换账号并重复提交生成副作用。
 */
async function pollScriptedApiImageTask(input: {
  config: ApiConfig;
  adapter: ApiUpstreamAdapterDraft;
  operation: "images.generate.query" | "images.edit.query";
  platformModelId: string;
  upstreamModelId: string;
  taskId: string;
  firstPollAfterSeconds?: number;
  signal?: AbortSignal;
}): Promise<GenerateImageResult> {
  try {
    resolveApiUpstreamRequestUrl({
      baseUrl: input.adapter.baseUrl,
      operation: input.operation,
      operations: input.adapter.operations,
      taskId: input.taskId,
      query: {},
    });
  } catch {
    return {
      error: "供应商请求处理失败，请联系管理员",
      backendSwitchAllowed: false,
    };
  }
  const deadline = Date.now() + API_IMAGE_POLL_BUDGET_MS;
  let consecutiveFailures = 0;
  let pollAfterSeconds =
    input.firstPollAfterSeconds ?? API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS;

  while (Date.now() < deadline) {
    await waitForApiImagePoll(pollAfterSeconds, input.signal);
    let executed: ApiUpstreamExecutionResult;
    try {
      executed = await executeApiUpstreamOperation({
        adapter: input.adapter,
        apiKey: input.config.apiKey,
        operation: input.operation,
        platformModelId: input.platformModelId,
        upstreamModelId: input.upstreamModelId,
        contentType: "application/json",
        taskId: input.taskId,
        signal: input.signal,
        maxResponseBytes: MAX_MEDIA_API_RESPONSE_BYTES,
        observability: {
          memberId: input.config.backend?.id,
          groupId: input.config.backend?.groupId,
        },
      });
    } catch (error) {
      if (
        error instanceof ApiUpstreamExecutionError &&
        !countsTowardApiUpstreamAdapterFailure(error)
      ) {
        // WHY：已接受图片任务不能因本地 Worker 饱和或一次网络抖动消耗适配
        // 失败预算；继续固定原账号轮询，仍受二十分钟总业务预算约束。
        pollAfterSeconds =
          error.retryAfterSeconds ?? API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS;
        continue;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_API_IMAGE_QUERY_FAILURES) {
        return convertApiImageExecutionError(error, true);
      }
      pollAfterSeconds = API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS;
      continue;
    }

    if (executed.kind === "built_in") {
      const parsed = await parseBuiltInApiImageResponse(executed.response);
      if (parsed.kind === "result") {
        return { ...parsed.result, backendSwitchAllowed: false };
      }
      consecutiveFailures = 0;
      pollAfterSeconds =
        parsed.pollAfterSeconds ?? API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS;
      continue;
    }
    consecutiveFailures = 0;
    const { result } = executed;
    if (result.status === "completed") {
      return convertScriptedImageOutputs(result);
    }
    if (result.status === "failed") {
      return {
        error: getScriptedImageFailureMessage(result),
        backendSwitchAllowed: false,
      };
    }
    pollAfterSeconds =
      executed.pollAfterSeconds ?? API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS;
  }
  return {
    error: "供应商图片任务轮询超时",
    backendSwitchAllowed: false,
  };
}

/** 解析六操作生成阶段结果；同步直接返回，异步固定原任务进入查询。 */
async function parseApiImageExecutionResult(input: {
  config: ApiConfig;
  adapter: ApiUpstreamAdapterDraft;
  operation: "images.generate" | "images.edit";
  platformModelId: string;
  upstreamModelId: string;
  executed: ApiUpstreamExecutionResult;
  callbacks?: ImageGenerationCallbacks;
  signal?: AbortSignal;
}): Promise<GenerateImageResult> {
  if (input.executed.kind === "built_in") {
    const parsed = await parseBuiltInApiImageResponse(
      input.executed.response,
      input.callbacks
    );
    if (parsed.kind === "result") return parsed.result;
    if (!parsed.taskId) {
      return {
        error: "供应商请求处理失败，请联系管理员",
        backendSwitchAllowed: false,
      };
    }
    logApiUpstreamImageTaskOrphanRisk({
      operation: input.operation,
      platformModelId: input.platformModelId,
      observability: {
        memberId: input.config.backend?.id,
        groupId: input.config.backend?.groupId,
      },
    });
    return pollScriptedApiImageTask({
      config: input.config,
      adapter: input.adapter,
      operation:
        input.operation === "images.generate"
          ? "images.generate.query"
          : "images.edit.query",
      platformModelId: input.platformModelId,
      upstreamModelId: input.upstreamModelId,
      taskId: parsed.taskId,
      firstPollAfterSeconds: parsed.pollAfterSeconds,
      signal: input.signal,
    });
  }
  const { result } = input.executed;
  if (result.status === "completed") {
    return convertScriptedImageOutputs(result);
  }
  if (result.status === "failed") {
    return {
      error: getScriptedImageFailureMessage(result),
      // WHY：响应脚本的默认语义是不重投。只有管理员通过 retryable 明确确认
      // 供应商未创建任务时，外层账号池才可安全切换成员。
      backendSwitchAllowed: result.retryable,
    };
  }
  if (!result.taskId) {
    return {
      error: "供应商请求处理失败，请联系管理员",
      backendSwitchAllowed: false,
    };
  }
  logApiUpstreamImageTaskOrphanRisk({
    operation: input.operation,
    platformModelId: input.platformModelId,
    observability: {
      memberId: input.config.backend?.id,
      groupId: input.config.backend?.groupId,
    },
  });
  const queryOperation: ApiUpstreamAdapterOperationId =
    input.operation === "images.generate"
      ? "images.generate.query"
      : "images.edit.query";
  if (
    queryOperation !== "images.generate.query" &&
    queryOperation !== "images.edit.query"
  ) {
    throw new Error("API 图片查询操作无效");
  }
  return pollScriptedApiImageTask({
    config: input.config,
    adapter: input.adapter,
    operation: queryOperation,
    platformModelId: input.platformModelId,
    upstreamModelId: input.upstreamModelId,
    taskId: result.taskId,
    firstPollAfterSeconds: input.executed.pollAfterSeconds,
    signal: input.signal,
  });
}

/**
 * api 后端（pool-api）分发前的输入图 re-host 守卫。
 *
 * 仅在最终选定的后端为 pool-api 且已知 userId 时生效：
 * 把待发送给上游的输入图和 mask 逐张确保转存到我方对象存储，避免把第三方
 * 外链交给上游（上游下载外链会被图床限流返回 "failed download file 429"）。
 *
 * 幂等：直接原地改写 params 内的 image 对象/字符串，已转存（带 storageKey 或
 * 第一方 url）的项会被 ensureInputImageRehosted 短路；重试时不会重复下载/上传。
 * 任何单张失败不影响其他图，也不中断主流程（失败语义见 ensureInputImageRehosted）。
 *
 * @param config 已选定的后端配置（用于判定 pool-api 与取 userId）。
 * @param params 含 images / mask 的请求参数（原地改写）。
 * @param signal 透传给下载的 abort 信号。
 */
async function rehostApiBackendInputImages(
  config: ApiConfig,
  params: {
    images?: ImageInputFile[];
    mask?: ImageInputFile;
  },
  signal?: AbortSignal
): Promise<void> {
  const backend = config.backend;
  if (backend?.type !== "pool-api") return;
  const userId = backend.userId?.trim();
  if (!userId) return;

  const generationId = backend.id || "rehost";

  if (params.images?.length) {
    for (let index = 0; index < params.images.length; index++) {
      const image = params.images[index];
      if (!image) continue;
      params.images[index] = await ensureInputImageRehosted(image, {
        userId,
        generationId,
        scope: "rehost",
        index,
        signal,
      });
    }
  }

  if (params.mask) {
    params.mask = await ensureInputImageRehosted(params.mask, {
      userId,
      generationId,
      scope: "rehost-mask",
      index: 0,
      signal,
    });
  }
}

// adobe（pool-adobe）派发：用 Firefly 适配器构造 /v1/chat/completions 请求，解析产物
// URL 后取回字节返回 base64（由管线 re-host），不长期依赖 adobe2api 本机 /generated URL。
// 文生图只传 prompt；图生图把输入图以 base64 data URL 放进 messages。
async function runAdobeImageRequest(
  config: ApiConfig,
  params: {
    prompt: string;
    model?: string | null;
    size?: string | null;
    quality?: string | null;
    images?: Array<{ data: Buffer; type?: string | null }>;
    signal?: AbortSignal;
  }
): Promise<GenerateImageResult> {
  if (
    !canAdobeBackendServeModel({
      enabledModels: config.backend?.adobeEnabledModels,
      supportsVideo: config.backend?.adobeSupportsVideo ?? false,
      requestedModel: params.model,
    })
  ) {
    return { error: "此 Adobe 后端未开放所请求的模型" };
  }
  // direct 模式：用本仓库移植的逆向逻辑直连 Adobe Firefly（经 Go TLS 旁路），不走网关。
  if (config.backend?.adobeMode === "direct") {
    return runAdobeDirectImageRequest(config, params);
  }
  // 网关模式：family 优先取请求 model 的族（支持 firefly-* 与裸 Nano Banana）；普通或未知
  // 模型（如普通 gpt-image 经 force_firefly 强制路由到 adobe）落 gpt-image-2。
  const family = pickExplicitAdobeImageFamily(params.model) ?? "gpt-image-2";
  const body = buildAdobeImageRequestBody({
    family,
    prompt: params.prompt,
    size: params.size,
    ...(params.images && params.images.length > 0
      ? { images: params.images }
      : {}),
  });
  const response = await fetchMediaUpstream(
    `${stripTrailingSlash(config.baseUrl)}/v1/chat/completions`,
    {
      method: "POST",
      signal: params.signal,
      headers: getHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      maxResponseBytes: MAX_MEDIA_API_RESPONSE_BYTES,
    }
  );
  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    return {
      error: getHttpErrorMessage(response, rawBody, "Adobe Firefly API"),
    };
  }
  const json = (await response.json().catch(() => null)) as unknown;
  const parsed = parseAdobeMediaResult(json, config.baseUrl);
  if ("error" in parsed) return { error: parsed.error };
  const mediaResponse = await fetchMediaUpstreamDownload(parsed.url, {
    signal: params.signal,
  });
  if (!mediaResponse.ok) {
    return {
      error: `Adobe Firefly 媒体下载失败 HTTP ${mediaResponse.status}`,
    };
  }
  const buffer = Buffer.from(await mediaResponse.arrayBuffer());
  return { imageBase64: buffer.toString("base64") };
}

export async function generateImage(
  config: ApiConfig,
  params: GenerateImageParams,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  const model = getModel(config, params.model);
  if (config.backend?.type === "pool-adobe") {
    return requireImageOutput(
      applyPromptOptimizationResultVisibility(
        await runAdobeImageRequest(config, {
          prompt: getEffectivePrompt(params),
          model,
          size: params.size,
          quality: params.quality,
          signal: params.signal,
        })
      )
    );
  }
  try {
    const prompt = getEffectivePrompt(params);
    const size = params.size || DEFAULT_IMAGE_SIZE;
    const dimensions = parseImageSize(size);
    const background = normalizeImageBackground(params.background);
    const upstreamModel = getApiBackendUpstreamModel(config, model);
    const requestBody = {
      model: upstreamModel,
      // images 端点不吃 prompt_cache_key,改在 prompt 注入每请求唯一零宽 nonce,
      // 打掉上游中转按请求体内容缓存导致的"同图同词出同图"。仅作用于上游请求体。
      prompt: appendImagesUpstreamNonce(prompt),
      n: params.n || 1,
      size,
      ...(dimensions
        ? { width: dimensions.width, height: dimensions.height }
        : {}),
      ...(normalizeQuality(params.quality)
        ? { quality: normalizeQuality(params.quality) }
        : {}),
      ...(normalizeModeration(params.moderation)
        ? { moderation: normalizeModeration(params.moderation) }
        : {}),
      ...(normalizeOutputFormat(params.outputFormat)
        ? { output_format: normalizeOutputFormat(params.outputFormat) }
        : {}),
      ...(normalizeOutputCompression(params.outputCompression) !== undefined
        ? {
            output_compression: normalizeOutputCompression(
              params.outputCompression
            ),
          }
        : {}),
      ...(background ? { background } : {}),
      ...(config.useStream ? { stream: true, partial_images: 2 } : {}),
      response_format: "b64_json",
    };
    if (config.backend?.type === "pool-api") {
      const adapter = getApiUpstreamAdapter(config);
      let executed: ApiUpstreamExecutionResult;
      try {
        executed = await executeApiUpstreamOperation({
          adapter,
          apiKey: config.apiKey,
          operation: "images.generate",
          platformModelId: model,
          upstreamModelId: upstreamModel,
          contentType: "application/json",
          body: requestBody,
          signal: params.signal,
          maxResponseBytes: MAX_MEDIA_API_RESPONSE_BYTES,
          observability: {
            memberId: config.backend.id,
            groupId: config.backend.groupId,
          },
        });
      } catch (error) {
        return convertApiImageExecutionError(error, false);
      }
      return requireImageOutput(
        applyPromptOptimizationResultVisibility(
          await parseApiImageExecutionResult({
            config,
            adapter,
            operation: "images.generate",
            platformModelId: model,
            upstreamModelId: upstreamModel,
            executed,
            callbacks,
            signal: params.signal,
          })
        )
      );
    }
    const response = await fetchMediaUpstream(
      `${config.baseUrl}/images/generations`,
      {
        method: "POST",
        signal: params.signal,
        headers: getHeaders(config, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(requestBody),
        maxResponseBytes: MAX_MEDIA_API_RESPONSE_BYTES,
      }
    );

    return requireImageOutput(
      applyPromptOptimizationResultVisibility(
        await parseImageResponse(response, callbacks)
      )
    );
  } catch (error) {
    logImageRequestError(error, {
      operation: "generate",
      baseUrl: config.baseUrl,
      path: "/images/generations",
      model,
      useStream: config.useStream,
    });
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/**
 * 将改图提示词中的 `@图N` 转为与对应输入图绑定的稳定引用标签。
 *
 * @param prompt - 已选择原始或优化版本的改图提示词。
 * @param images - 按用户提交顺序排列的输入图。
 * @returns 仅替换存在对应输入图的引用；越界引用保持原文。
 */
function resolveEditPromptReferences(
  prompt: string,
  images: ImageInputFile[]
): string {
  return prompt.replace(/@图(\d+)/g, (text, imageNumber: string) => {
    const index = Number(imageNumber) - 1;
    const image = images[index];
    if (!image) return text;
    const safeName = image.name
      .slice(0, 500)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<ref id="edit-reference-${index + 1}" prompt="${safeName}" />`;
  });
}

export async function editImage(
  config: ApiConfig,
  params: EditImageParams,
  callbacks?: ImageGenerationCallbacks
): Promise<GenerateImageResult> {
  // Adobe 适配器不会把 mask 传给上游。这里必须 fail-closed，避免局部编辑
  // 被静默降级为整图编辑；正常路径会在 operations 中先重选 image_edit 候选。
  if (params.mask && config.backend?.type === "pool-adobe") {
    return { error: "当前生图后端不支持蒙版编辑，已阻止请求发送。" };
  }

  // pool-api 后端分发前确保输入图/ mask 已 re-host，避免把外链交给上游。
  await rehostApiBackendInputImages(
    config,
    { images: params.images, mask: params.mask },
    params.signal
  );

  const model = getModel(config, params.model);
  const effectiveEditPrompt = resolveEditPromptReferences(
    getEffectivePrompt(params),
    params.images
  );
  if (config.backend?.type === "pool-adobe") {
    return requireImageOutput(
      applyPromptOptimizationResultVisibility(
        await runAdobeImageRequest(config, {
          prompt: effectiveEditPrompt,
          model,
          size: params.size,
          quality: params.quality,
          images: params.images,
          signal: params.signal,
        })
      )
    );
  }
  try {
    const prompt = effectiveEditPrompt;
    const upstreamModel = getApiBackendUpstreamModel(config, model);
    const formData = new FormData();
    appendImageParams(formData, config, {
      prompt,
      model: upstreamModel,
      n: params.n,
      size: params.size,
      quality: params.quality,
      moderation: params.moderation,
      outputFormat: params.outputFormat,
      outputCompression: params.outputCompression,
      background: params.background,
      promptOptimization: params.promptOptimization,
    });

    for (const image of params.images) {
      formData.append(
        params.images.length === 1 ? "image" : "image[]",
        new Blob([toBlobPart(image.data)], { type: image.type }),
        image.name
      );
    }

    if (params.mask) {
      formData.append(
        "mask",
        new Blob([toBlobPart(params.mask.data)], { type: params.mask.type }),
        params.mask.name
      );
    }

    if (config.backend?.type === "pool-api") {
      const adapter = getApiUpstreamAdapter(config);
      const request = createApiBackendFormDataRequest(formData);
      let executed: ApiUpstreamExecutionResult;
      try {
        executed = await executeApiUpstreamOperation({
          adapter,
          apiKey: config.apiKey,
          operation: "images.edit",
          platformModelId: model,
          upstreamModelId: upstreamModel,
          contentType: "multipart/form-data",
          body: request.body,
          opaqueValues: request.opaqueValues,
          signal: params.signal,
          maxResponseBytes: MAX_MEDIA_API_RESPONSE_BYTES,
          encodeBody: encodeApiBackendFormDataRequest,
          observability: {
            memberId: config.backend.id,
            groupId: config.backend.groupId,
          },
        });
      } catch (error) {
        return convertApiImageExecutionError(error, false);
      }
      return requireImageOutput(
        applyPromptOptimizationResultVisibility(
          await parseApiImageExecutionResult({
            config,
            adapter,
            operation: "images.edit",
            platformModelId: model,
            upstreamModelId: upstreamModel,
            executed,
            callbacks,
            signal: params.signal,
          })
        )
      );
    }
    const response = await fetchMediaUpstream(
      `${config.baseUrl}/images/edits`,
      {
        method: "POST",
        signal: params.signal,
        headers: getHeaders(config, {}),
        body: formData,
        maxResponseBytes: MAX_MEDIA_API_RESPONSE_BYTES,
      }
    );

    return requireImageOutput(
      applyPromptOptimizationResultVisibility(
        await parseImageResponse(response, callbacks)
      )
    );
  } catch (error) {
    logImageRequestError(error, {
      operation: "edit",
      baseUrl: config.baseUrl,
      path: "/images/edits",
      model,
      useStream: config.useStream,
    });
    return {
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}
