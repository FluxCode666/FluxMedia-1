/**
 * 单张图片上游适配与后端池重试服务。
 *
 * 使用方：`operations.ts` 的统一图片管线、账号池测活与 Adobe 视频配置解析。
 * 本文件只保留 Images API、Adobe gateway/direct、输入图转存和通用图片 SSE 解析；
 * 对话、Agent、Responses 工具循环与可编辑文件运行时不在此层。
 */
import {
  buildAdobeImageRequestBody,
  canAdobeBackendServeModel,
  isAdobeImageFamilyModelId,
  parseAdobeMediaResult,
  pickExplicitAdobeImageFamily,
} from "@repo/shared/adobe";
import {
  applyRequestParameterMappings,
  normalizeRequestParameterMappings,
} from "@repo/shared/image-backend/request-parameter-mapping";
import { logError } from "@repo/shared/logger";
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

function getModel(config: ApiConfig, model?: string) {
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

/**
 * 将 API 池后端保存的字段映射应用到 JSON 请求体。
 *
 * 只有管理员配置的 pool-api 可使用映射；平台、用户自配 API 与 OAuth 账号始终发送
 * 原始标准请求，避免任何配置越过其既有协议与安全边界。
 *
 * @param config - 当前选中的上游配置。
 * @param requestBody - 已完成标准化、即将序列化的 JSON 请求体。
 * @returns 应用映射后的独立请求体。
 */
function applyApiBackendRequestMappings(
  config: ApiConfig,
  requestBody: unknown
) {
  if (config.backend?.type !== "pool-api" || !isPlainRecord(requestBody)) {
    return requestBody;
  }
  return applyRequestParameterMappings(
    requestBody,
    config.backend.parameterMappings
  );
}

/**
 * 将一个 FormData 条目值追加到新表单。
 *
 * @param formData - 重建中的上游 multipart 表单。
 * @param name - 上游字段名称。
 * @param value - 字符串或 Blob；其他值仅在异常配置下转成字符串。
 */
function appendMappedFormDataValue(
  formData: FormData,
  name: string,
  value: unknown
) {
  if (typeof value === "string") {
    formData.append(name, value);
    return;
  }
  if (value instanceof Blob) {
    formData.append(name, value);
    return;
  }
  formData.append(name, String(value));
}

/**
 * 对 multipart 改图表单应用顶层字段映射。
 *
 * FormData 没有 JSON 嵌套语义，故仅处理无点号的字段名；`image`、`mask` 等 Blob
 * 会连同重复条目一起保留。带点号的规则只在 JSON Images 请求中生效。
 *
 * @param config - 当前选中的上游配置。
 * @param formData - 标准化后的 multipart 表单。
 * @returns 上游可直接发送的新表单。
 */
function applyApiBackendFormDataMappings(
  config: ApiConfig,
  formData: FormData
) {
  if (config.backend?.type !== "pool-api") return formData;
  const mappings = normalizeRequestParameterMappings(
    config.backend.parameterMappings
  ).filter(
    (mapping) => !mapping.source.includes(".") && !mapping.target.includes(".")
  );
  if (!mappings.length) return formData;

  const entries = new Map<string, FormDataEntryValue[]>();
  for (const [name, value] of formData.entries()) {
    const values = entries.get(name) || [];
    values.push(value);
    entries.set(name, values);
  }
  const snapshot = new Map(entries);
  const resolved = mappings.flatMap((mapping) => {
    const sourceName = snapshot.has(mapping.source)
      ? mapping.source
      : mapping.source === "image" && snapshot.has("image[]")
        ? "image[]"
        : mapping.source;
    const values = snapshot.get(sourceName);
    return values ? [{ ...mapping, sourceName, values }] : [];
  });
  for (const mapping of resolved) {
    if (mapping.mode === "move" && mapping.source !== mapping.target) {
      entries.delete(mapping.sourceName);
    }
  }
  for (const mapping of resolved) {
    entries.set(mapping.target, [...mapping.values]);
  }

  const mapped = new FormData();
  for (const [name, values] of entries) {
    for (const value of values) appendMappedFormDataValue(mapped, name, value);
  }
  return mapped;
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
    model?: string;
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
  formData.append("model", getModel(config, params.model));
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

/**
 * api 后端（pool-api）分发前的输入图 re-host 守卫。
 *
 * 仅在最终选定的后端为 pool-api 且已知 userId 时生效（account 后端不受影响）：
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
    const response = await fetchMediaUpstream(
      `${config.baseUrl}/images/generations`,
      {
        method: "POST",
        signal: params.signal,
        headers: getHeaders(config, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(
          applyApiBackendRequestMappings(config, {
            model,
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
            ...(normalizeOutputCompression(params.outputCompression) !==
            undefined
              ? {
                  output_compression: normalizeOutputCompression(
                    params.outputCompression
                  ),
                }
              : {}),
            ...(background ? { background } : {}),
            ...(config.useStream ? { stream: true, partial_images: 2 } : {}),
            response_format: "b64_json",
          })
        ),
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
    const formData = new FormData();
    appendImageParams(formData, config, {
      prompt,
      model,
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

    const response = await fetchMediaUpstream(
      `${config.baseUrl}/images/edits`,
      {
        method: "POST",
        signal: params.signal,
        headers: getHeaders(config, {}),
        body: applyApiBackendFormDataMappings(config, formData),
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
