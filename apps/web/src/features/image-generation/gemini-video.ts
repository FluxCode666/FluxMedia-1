/**
 * Gemini Veo 上游视频适配器。
 *
 * 职责：把固定 API 成员的规范视频输入转换为 Gemini Developer API 的
 * predictLongRunning/Operation 请求，解析官方 LRO 结构并保留完整上游 operation name。
 * 使用方是 api-video；本模块不负责账号调度、计费、任务阶段或回调。
 */
import type { ApiUpstreamAdapterDraft } from "@repo/shared/image-backend/api-upstream-adaptation";
import type { ApiUpstreamRequestSnapshot } from "@repo/shared/image-backend/api-upstream-script-contract";
import { geminiVideoParametersSchema } from "@repo/shared/video-generation";
import { z } from "zod";
import { createApiUpstreamAuthenticationHeaders } from "@/features/image-backend-pool/api-upstream-auth";
import { createApiUpstreamRequestSnapshot } from "@/features/image-backend-pool/api-upstream-request-snapshot";
import { fetchMediaUpstream } from "@/features/image-backend-pool/media-upstream-fetch";
import { ApiAcceptedVideoError } from "./api-video-error";

const MAX_GEMINI_RESPONSE_BYTES = 2 * 1024 * 1024;
const GEMINI_MODEL_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const GEMINI_OPERATION_NAME_PATTERN =
  /^models\/[A-Za-z0-9][A-Za-z0-9._:-]{0,119}\/operations\/[^/]{1,512}$/u;
const GEMINI_ALLOWED_DURATIONS = new Set([4, 6, 8]);

/** Gemini 旧适配契约中的图片媒体对象；保留给 DB-free 调用方和测试。 */
export type GeminiVideoImage = {
  bytesBase64Encoded: string;
  mimeType: string;
};

/** Gemini 旧适配契约的规范输入；运行时成员适配器使用 Buffer 版本。 */
export type GeminiVideoRequestInput = {
  model: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  firstFrame?: GeminiVideoImage;
  lastFrame?: GeminiVideoImage;
  referenceImages?: readonly GeminiVideoImage[];
};

/** Gemini 官方创建请求的 DB-free 投影。 */
export type GeminiVideoRequest = {
  path: string;
  body: {
    instances: readonly [
      {
        prompt: string;
        image?: GeminiVideoImage;
        lastFrame?: GeminiVideoImage;
        referenceImages?: readonly {
          image: GeminiVideoImage;
          referenceType: "asset";
        }[];
      },
    ];
    parameters: {
      aspectRatio: string;
      resolution: string;
      durationSeconds: string;
    };
  };
};

/** Google Status 风格错误的脱敏旧投影。 */
export type GeminiVideoOperationError = {
  code?: number;
  message: string;
};

/** 旧纯函数查询结果；运行时查询错误通过 ApiAcceptedVideoError 收敛。 */
export type GeminiVideoContractPollResult =
  | { status: "pending"; raw: Record<string, unknown> }
  | { status: "completed"; videoUrl: string; raw: Record<string, unknown> }
  | {
      status: "failed";
      error: GeminiVideoOperationError;
      raw: Record<string, unknown>;
    };

const upstreamOperationSchema = z
  .object({
    name: z.string().trim().regex(GEMINI_OPERATION_NAME_PATTERN),
    done: z.boolean().default(false),
    response: z
      .object({
        generateVideoResponse: z
          .object({
            generatedSamples: z
              .array(
                z
                  .object({
                    video: z.object({ uri: z.string().url() }).strict(),
                  })
                  .strict()
              )
              .min(1),
          })
          .strict(),
      })
      .strict()
      .optional(),
    error: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (!operation.done && (operation.response || operation.error)) {
      context.addIssue({
        code: "custom",
        path: ["done"],
        message: "Pending Gemini Operation cannot contain a terminal result",
      });
    }
    if (
      operation.done &&
      Boolean(operation.response) === Boolean(operation.error)
    ) {
      context.addIssue({
        code: "custom",
        path: ["done"],
        message: "Completed Gemini Operation must contain response or error",
      });
    }
  });

export type GeminiVideoSourceImage = {
  data: Buffer;
  type: string;
};

export type GeminiVideoSubmission =
  | {
      status: "pending";
      upstreamOperationName: string;
      pollAfterSeconds?: number;
      raw: Record<string, unknown>;
    }
  | { status: "completed"; videoUrl: string; raw: Record<string, unknown> };

export type GeminiVideoStageError = {
  error: string;
  failure: {
    kind:
      | "timeout"
      | "network"
      | "response_read"
      | "response_parse"
      | "missing_operation_name"
      | "unknown";
    statusCode?: number;
  };
  retryAfterSeconds?: number;
};

export type GeminiVideoPollResult =
  | {
      status: "pending";
      pollAfterSeconds?: number;
      raw: Record<string, unknown>;
    }
  | { status: "completed"; videoUrl: string; raw: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 判断不可信文本中的 ASCII 控制字符。 */
function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

/** 移除不可信文本中的 ASCII 控制字符。 */
function replaceAsciiControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
}

function assertSafeString(value: string, field: string): void {
  if (!value.trim() || containsAsciiControlCharacter(value)) {
    throw new Error(`Gemini ${field} is invalid`);
  }
}

/** 校验公开模型路径段；模型名只决定模型，不参与上游协议选择。 */
export function assertGeminiModelPathSegment(model: string): string {
  assertSafeString(model, "model");
  const normalized = model.trim();
  if (!GEMINI_MODEL_SEGMENT_PATTERN.test(normalized)) {
    throw new Error("Gemini model path is invalid");
  }
  return normalized;
}

function assertGeminiImage(image: GeminiVideoImage, field: string): void {
  if (!isRecord(image)) throw new Error(`Gemini ${field} is invalid`);
  if (
    typeof image.bytesBase64Encoded !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      image.bytesBase64Encoded
    ) ||
    image.bytesBase64Encoded.length > 16 * 1024 * 1024
  ) {
    throw new Error(`Gemini ${field}.bytesBase64Encoded is invalid`);
  }
  if (
    typeof image.mimeType !== "string" ||
    !/^image\/[A-Za-z0-9.+-]+$/u.test(image.mimeType)
  ) {
    throw new Error(`Gemini ${field}.mimeType is invalid`);
  }
}

/** 构造保留的纯 Gemini 请求合约，不访问网络或成员凭据。 */
export function buildGeminiVideoRequest(
  input: GeminiVideoRequestInput
): GeminiVideoRequest {
  const model = assertGeminiModelPathSegment(input.model);
  assertSafeString(input.prompt, "prompt");
  assertSafeString(input.aspectRatio, "aspectRatio");
  assertSafeString(input.resolution, "resolution");
  if (!GEMINI_ALLOWED_DURATIONS.has(input.duration)) {
    throw new Error("Gemini duration must be 4, 6, or 8 seconds");
  }
  if (input.lastFrame && !input.firstFrame) {
    throw new Error("Gemini lastFrame requires firstFrame");
  }
  const references = input.referenceImages ?? [];
  if (references.length > 3) {
    throw new Error("Gemini supports at most 3 reference images");
  }
  if ((input.firstFrame || input.lastFrame) && references.length > 0) {
    throw new Error(
      "Gemini frame inputs and reference images are mutually exclusive"
    );
  }
  if (input.firstFrame) assertGeminiImage(input.firstFrame, "firstFrame");
  if (input.lastFrame) assertGeminiImage(input.lastFrame, "lastFrame");
  for (const [index, image] of references.entries()) {
    assertGeminiImage(image, `referenceImages[${index}]`);
  }
  const instance = {
    prompt: input.prompt.trim(),
    ...(input.firstFrame ? { image: input.firstFrame } : {}),
    ...(input.lastFrame ? { lastFrame: input.lastFrame } : {}),
    ...(references.length > 0
      ? {
          referenceImages: references.map((image) => ({
            image,
            referenceType: "asset" as const,
          })),
        }
      : {}),
  };
  return {
    path: `/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`,
    body: {
      instances: [instance],
      parameters: {
        aspectRatio: input.aspectRatio.trim(),
        resolution: input.resolution.trim(),
        // Gemini REST 将 durationSeconds 定义为 int64，JSON wire format 使用字符串。
        durationSeconds: String(input.duration),
      },
    },
  };
}

/** 解析并校验真实 Gemini 上游 operation.name。 */
export function parseGeminiUpstreamOperationName(value: unknown): string {
  if (typeof value !== "string" || !GEMINI_OPERATION_NAME_PATTERN.test(value)) {
    throw new Error("Gemini response is missing a valid operation name");
  }
  return value;
}

/** 解析 Gemini 创建响应，只有完整 operation.name 才算已接受。 */
export function parseGeminiVideoSubmission(
  value: unknown
): Extract<GeminiVideoSubmission, { status: "pending" }> {
  if (!isRecord(value)) throw new Error("Gemini response is not a JSON object");
  return {
    status: "pending",
    upstreamOperationName: parseGeminiUpstreamOperationName(value.name),
    raw: value,
  };
}

function readGeminiGeneratedVideoUri(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.response)) {
    throw new Error("Gemini operation response is missing response");
  }
  const generateVideoResponse = value.response.generateVideoResponse;
  if (!isRecord(generateVideoResponse)) {
    throw new Error(
      "Gemini operation response is missing generateVideoResponse"
    );
  }
  const samples = generateVideoResponse.generatedSamples;
  const first = Array.isArray(samples) && samples[0];
  const video = isRecord(first) ? first.video : undefined;
  const uri = isRecord(video) ? video.uri : undefined;
  if (typeof uri !== "string") {
    throw new Error("Gemini operation response is missing video URI");
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("Gemini video URI is invalid");
  }
  if (parsed.protocol !== "https:")
    throw new Error("Gemini video URI must use HTTPS");
  return parsed.toString();
}

function readGeminiOperationError(value: unknown): GeminiVideoOperationError {
  const error = isRecord(value) ? value.error : undefined;
  if (!isRecord(error) || typeof error.message !== "string") {
    throw new Error("Gemini operation error is invalid");
  }
  const message = error.message.replace(/\s+/gu, " ");
  const sanitizedMessage = replaceAsciiControlCharacters(message)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
  if (!sanitizedMessage) throw new Error("Gemini operation error is invalid");
  return {
    message: sanitizedMessage,
    ...(typeof error.code === "number" && Number.isSafeInteger(error.code)
      ? { code: error.code }
      : {}),
  };
}

/** 解析 Gemini 查询响应，纯函数版本供契约测试与调用方复用。 */
export function parseGeminiVideoPollResult(
  value: unknown
): GeminiVideoContractPollResult {
  if (!isRecord(value)) {
    throw new Error("Gemini operation response is not a JSON object");
  }
  if (value.done !== true) return { status: "pending", raw: value };
  if (value.error !== undefined) {
    return {
      status: "failed",
      error: readGeminiOperationError(value),
      raw: value,
    };
  }
  return {
    status: "completed",
    videoUrl: readGeminiGeneratedVideoUri(value),
    raw: value,
  };
}

async function readJson(
  value: Response
): Promise<Record<string, unknown> | null> {
  const text = await value.text();
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
  if (adapter.authentication.mode === "bearer") {
    if (!apiKey?.trim()) throw new Error("Gemini 上游认证缺少账号凭据");
    return { "x-goog-api-key": apiKey };
  }
  return createApiUpstreamAuthenticationHeaders(adapter.authentication, apiKey);
}

function createGeminiUrl(baseUrl: string, upstreamModel: string): string {
  const origin = baseUrl.replace(/\/+$/u, "");
  return `${origin}/v1beta/models/${encodeURIComponent(upstreamModel)}:predictLongRunning`;
}

function createGeminiPollUrl(baseUrl: string, operationName: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/v1beta/${parseGeminiUpstreamOperationName(
    operationName
  )}`;
}

function encodeImage(image: GeminiVideoSourceImage) {
  return {
    inlineData: {
      mimeType: image.type,
      data: image.data.toString("base64"),
    },
  };
}

function toFailure(
  kind: GeminiVideoStageError["failure"]["kind"] = "network"
): GeminiVideoStageError {
  return {
    error: "Gemini 视频上游请求失败",
    failure: { kind },
  };
}

function parseOperation(
  record: Record<string, unknown>,
  expectedModel?: string
): GeminiVideoSubmission | GeminiVideoStageError {
  const parsed = upstreamOperationSchema.safeParse({
    name: record.name,
    done: record.done,
    response: record.response,
    error: record.error,
  });
  if (!parsed.success) {
    return {
      error: "Gemini 视频上游响应缺少有效 Operation name",
      failure: { kind: "missing_operation_name" },
    };
  }
  if (
    expectedModel !== undefined &&
    !parsed.data.name.startsWith(
      `models/${assertGeminiModelPathSegment(expectedModel)}/operations/`
    )
  ) {
    return {
      error: "Gemini 视频上游响应的 Operation 模型不匹配",
      failure: { kind: "missing_operation_name" },
    };
  }
  const raw = record;
  if (!parsed.data.done) {
    return { status: "pending", upstreamOperationName: parsed.data.name, raw };
  }
  if (parsed.data.error) {
    // Operation 已完成但失败时必须终止当前任务，不能继续轮询或重新提交。
    return { status: "pending", upstreamOperationName: parsed.data.name, raw };
  }
  const uri =
    parsed.data.response?.generateVideoResponse.generatedSamples[0]?.video.uri;
  if (!uri) {
    // done=true,error 仍然是已被上游接受的 Operation；交给查询阶段按 accepted 错误收敛。
    return { status: "pending", upstreamOperationName: parsed.data.name, raw };
  }
  try {
    const parsedUri = new URL(uri);
    if (parsedUri.protocol !== "https:") throw new Error("not https");
    return { status: "completed", videoUrl: parsedUri.toString(), raw };
  } catch {
    return {
      error: "Gemini 视频上游响应缺少有效 HTTPS 视频地址",
      failure: { kind: "response_parse" },
    };
  }
}

/** 读取 Google Status 的可持久化错误消息，不保存 details 或原始正文。 */
function readTerminalOperationError(record: Record<string, unknown>): string {
  const error = isRecord(record.error) ? record.error : undefined;
  const message =
    typeof error?.message === "string" ? error.message : "Gemini 视频任务失败";
  const sanitized = message.replace(/\s+/gu, " ");
  const normalized = replaceAsciiControlCharacters(sanitized)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
  return normalized || "Gemini 视频任务失败";
}

export async function submitGeminiVideoRequest(input: {
  adapter: ApiUpstreamAdapterDraft;
  apiKey: string | null;
  upstreamModel: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  effectiveAudio: boolean;
  firstFrame?: GeminiVideoSourceImage;
  lastFrame?: GeminiVideoSourceImage;
  referenceImages?: GeminiVideoSourceImage[];
  /** 真正发出上游请求前预留 API 创建尝试次数。 */
  onBeforeSend?: () => Promise<void> | void;
  /** 持久化不含媒体正文和凭据的最终请求快照。 */
  onRequestSnapshot?: (
    snapshot: ApiUpstreamRequestSnapshot
  ) => Promise<void> | void;
  signal?: AbortSignal;
}): Promise<GeminiVideoSubmission | GeminiVideoStageError> {
  let upstreamModel: string;
  try {
    upstreamModel = assertGeminiModelPathSegment(input.upstreamModel);
  } catch {
    return {
      error: "Gemini 视频模型名称无效",
      failure: { kind: "unknown", statusCode: 400 },
    };
  }
  if (input.effectiveAudio === false) {
    return {
      error: "Gemini Veo 原生始终生成音频，不支持关闭音频",
      failure: { kind: "unknown", statusCode: 400 },
    };
  }
  const parameters = geminiVideoParametersSchema.safeParse({
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    durationSeconds: input.duration,
  });
  if (!parameters.success) {
    return {
      error: "Gemini 视频参数不受支持",
      failure: { kind: "unknown", statusCode: 400 },
    };
  }
  const instance: Record<string, unknown> = { prompt: input.prompt };
  if (input.firstFrame) instance.image = encodeImage(input.firstFrame);
  if (input.lastFrame) instance.lastFrame = encodeImage(input.lastFrame);
  if (input.referenceImages?.length) {
    instance.referenceImages = input.referenceImages.map((image) => ({
      image: encodeImage(image),
      referenceType: "asset",
    }));
  }
  const body = {
    instances: [instance],
    parameters: {
      ...parameters.data,
      // Gemini REST 将 durationSeconds 定义为 int64，JSON wire format 使用字符串。
      durationSeconds: String(parameters.data.durationSeconds),
    },
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
      error: "Gemini 视频请求快照生成失败",
      failure: { kind: "unknown" },
    };
  }
  let response: Response;
  try {
    await input.onBeforeSend?.();
  } catch {
    return {
      error: "Gemini 视频请求尚未发送",
      failure: { kind: "unknown" },
    };
  }
  try {
    response = await fetchMediaUpstream(
      createGeminiUrl(input.adapter.baseUrl, upstreamModel),
      {
        method: "POST",
        headers: {
          ...authHeaders(input.adapter, input.apiKey),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: input.signal,
        maxResponseBytes: MAX_GEMINI_RESPONSE_BYTES,
      }
    );
  } catch {
    return toFailure(input.signal?.aborted ? "timeout" : "network");
  }
  if (!response.ok) {
    return {
      error: `Gemini 视频上游返回 HTTP ${response.status}`,
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
      error: "Gemini 视频上游响应读取失败",
      failure: { kind: "response_read" },
    };
  }
  if (!record)
    return {
      error: "Gemini 视频上游响应不是有效 JSON",
      failure: { kind: "response_parse" },
    };
  return parseOperation(record, upstreamModel);
}

export async function pollGeminiVideoRequest(input: {
  adapter: ApiUpstreamAdapterDraft;
  apiKey: string | null;
  upstreamModel?: string;
  operationName: string;
  signal?: AbortSignal;
}): Promise<GeminiVideoPollResult> {
  let response: Response;
  try {
    response = await fetchMediaUpstream(
      createGeminiPollUrl(input.adapter.baseUrl, input.operationName),
      {
        method: "GET",
        headers: authHeaders(input.adapter, input.apiKey),
        signal: input.signal,
        maxResponseBytes: MAX_GEMINI_RESPONSE_BYTES,
      }
    );
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Gemini 视频查询失败"
    );
  }
  if (!response.ok) {
    throw new Error(`Gemini 视频查询返回 HTTP ${response.status}`);
  }
  let record: Record<string, unknown> | null;
  try {
    record = await readJson(response);
  } catch {
    throw new ApiAcceptedVideoError("Gemini 视频查询响应读取失败", true);
  }
  if (!record) throw new Error("Gemini 视频查询响应不是有效 JSON");
  if (record.done === true && record.error !== undefined) {
    throw new ApiAcceptedVideoError(
      readTerminalOperationError(record),
      false,
      typeof record.error === "object" &&
        record.error !== null &&
        "code" in record.error
        ? Number((record.error as { code?: unknown }).code) || undefined
        : undefined
    );
  }
  const parsed = parseOperation(record, input.upstreamModel);
  if ("error" in parsed) throw new ApiAcceptedVideoError(parsed.error, false);
  if (record.done === true && parsed.status === "pending") {
    throw new ApiAcceptedVideoError(
      "Gemini 视频上游响应缺少有效完成结果",
      false
    );
  }
  return parsed.status === "pending"
    ? { status: "pending", raw: parsed.raw }
    : { status: "completed", videoUrl: parsed.videoUrl, raw: parsed.raw };
}
