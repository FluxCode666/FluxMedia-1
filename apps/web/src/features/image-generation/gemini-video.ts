/**
 * Gemini Developer API 视频适配契约。
 *
 * 职责：把统一视频输入转换为 Gemini `predictLongRunning` 的严格请求，并解析 Google
 * Long-running Operation 的创建、处理中、成功和失败响应。使用方是 API 视频状态机；
 * 本文件不负责成员选择、计费、任务持久化或公共响应投影。
 */

/** Gemini 图片媒体对象；媒体正文由调用方在受信边界内转换为 base64。 */
export type GeminiVideoImage = {
  bytesBase64Encoded: string;
  mimeType: string;
};

/** 统一视频输入传给 Gemini 适配器的最小字段集合。 */
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

/** Gemini 上游请求的相对路径和 JSON 正文。 */
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
      durationSeconds: number;
    };
  };
};

/** Google Status 风格的失败正文；details 不向公共 API 透传。 */
export type GeminiVideoOperationError = {
  code?: number;
  message: string;
};

/** Gemini Operation 创建响应解析结果。 */
export type GeminiVideoSubmission = {
  status: "pending";
  upstreamOperationName: string;
  raw: Record<string, unknown>;
};

/** Gemini Operation 查询解析结果。 */
export type GeminiVideoPollResult =
  | {
      status: "pending";
      raw: Record<string, unknown>;
    }
  | {
      status: "completed";
      videoUrl: string;
      raw: Record<string, unknown>;
    }
  | {
      status: "failed";
      error: GeminiVideoOperationError;
      raw: Record<string, unknown>;
    };

const GEMINI_MODEL_SEGMENT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const GEMINI_OPERATION_NAME_PATTERN =
  /^models\/([A-Za-z0-9][A-Za-z0-9._:-]{0,119})\/operations\/([^/]{1,512})$/u;
const GEMINI_ALLOWED_DURATIONS = new Set([4, 6, 8]);

/** 判断未知值是否为无数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 断言字符串没有控制字符，避免把不可见内容送入上游路径或 JSON。 */
function assertSafeString(value: string, field: string): void {
  if (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Gemini ${field} is invalid`);
  }
}

/** 校验并返回公开模型路径段；模型名称不参与上游协议选择。 */
export function assertGeminiModelPathSegment(model: string): string {
  assertSafeString(model, "model");
  const normalized = model.trim();
  if (!GEMINI_MODEL_SEGMENT_PATTERN.test(normalized)) {
    throw new Error("Gemini model path is invalid");
  }
  return normalized;
}

/** 校验 Gemini 图片正文和 MIME 类型。 */
function assertGeminiImage(image: GeminiVideoImage, field: string): void {
  if (!isRecord(image)) throw new Error(`Gemini ${field} is invalid`);
  if (
    typeof image.bytesBase64Encoded !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.bytesBase64Encoded) ||
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

/** 构造官方 Gemini `models/{model}:predictLongRunning` 请求。 */
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
    throw new Error("Gemini frame inputs and reference images are mutually exclusive");
  }
  if (input.firstFrame) assertGeminiImage(input.firstFrame, "firstFrame");
  if (input.lastFrame) assertGeminiImage(input.lastFrame, "lastFrame");
  references.forEach((image, index) =>
    assertGeminiImage(image, `referenceImages[${index}]`)
  );

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
        durationSeconds: input.duration,
      },
    },
  };
}

/** 解析并校验 Google 上游 Operation name；不得接受 URL 或额外路径段。 */
export function parseGeminiUpstreamOperationName(value: unknown): string {
  if (typeof value !== "string" || !GEMINI_OPERATION_NAME_PATTERN.test(value)) {
    throw new Error("Gemini response is missing a valid operation name");
  }
  return value;
}

/** 解析 Gemini 创建响应，只有有效 Operation name 才算提交已接受。 */
export function parseGeminiVideoSubmission(
  value: unknown
): GeminiVideoSubmission {
  if (!isRecord(value)) {
    throw new Error("Gemini response is not a JSON object");
  }
  return {
    status: "pending",
    upstreamOperationName: parseGeminiUpstreamOperationName(value.name),
    raw: value,
  };
}

/** 读取官方生成样本视频 URI，并限制为 HTTPS 绝对地址。 */
function readGeminiGeneratedVideoUri(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.response)) {
    throw new Error("Gemini operation response is missing response");
  }
  const generateVideoResponse = value.response.generateVideoResponse;
  if (!isRecord(generateVideoResponse)) {
    throw new Error("Gemini operation response is missing generateVideoResponse");
  }
  const samples = generateVideoResponse.generatedSamples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("Gemini operation response has no generated video");
  }
  const video = isRecord(samples[0]) ? samples[0].video : undefined;
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
  if (parsed.protocol !== "https:") {
    throw new Error("Gemini video URI must use HTTPS");
  }
  return parsed.toString();
}

/** 读取 Google Status 风格错误并移除正文细节，供任务错误映射使用。 */
function readGeminiOperationError(value: unknown): GeminiVideoOperationError {
  const error = isRecord(value) ? value.error : undefined;
  if (!isRecord(error) || typeof error.message !== "string") {
    throw new Error("Gemini operation error is invalid");
  }
  const message = error.message
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
  if (!message) throw new Error("Gemini operation error is invalid");
  return {
    message,
    ...(typeof error.code === "number" && Number.isSafeInteger(error.code)
      ? { code: error.code }
      : {}),
  };
}

/** 解析官方 Gemini Operation 查询响应。 */
export function parseGeminiVideoPollResult(
  value: unknown
): GeminiVideoPollResult {
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

