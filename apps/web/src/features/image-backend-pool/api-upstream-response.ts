/**
 * API 上游响应脚本输入与统一结果解析。
 *
 * 职责：只暴露安全 Header、有界 JSON/文本和脱敏上下文，规范任务状态并计算内部
 * 轮询下限；上游正文、脚本和任务 ID不进入日志或用户错误。
 */
import {
  API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS,
  type ApiUpstreamAdapterOperationId,
  type ApiUpstreamResponseResult,
  type ApiUpstreamScriptContext,
  apiUpstreamResponseInputSchema,
  apiUpstreamResponseResultForOperationSchema,
  isApiUpstreamQueryOperation,
} from "@repo/shared/image-backend/api-upstream-script-contract";

import {
  assertApiUpstreamOpaqueValuesPreserved,
  restoreApiUpstreamOpaqueValues,
  tokenizeApiUpstreamOpaqueValues,
} from "./api-upstream-opaque-values";
import type { ApiUpstreamResponsePermit } from "./api-upstream-script-pool";
import { runApiUpstreamResponseScript } from "./api-upstream-script-runtime";

const SAFE_RESPONSE_HEADER_NAMES = [
  "content-type",
  "retry-after",
  "request-id",
  "x-request-id",
] as const;

const IMAGE_BASE64_FIELD_NAMES = new Set([
  "b64",
  "b64json",
  "base64",
  "base64image",
  "imageb64",
  "imagebase64",
  "partialimageb64",
]);

/** 规范供应商字段名，以兼容 snake_case、camelCase 和 kebab-case。 */
function normalizeMediaFieldName(fieldName: string): string {
  return fieldName.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
}

/** 读取很短的 Base64 前缀，以图片魔数识别未知供应商字段中的媒体。 */
function hasBase64ImageSignature(value: string): boolean {
  const encodedPrefix = value.slice(0, 128).replaceAll(/\s/gu, "");
  if (
    encodedPrefix.length < 8 ||
    !/^[a-z0-9+/_-]+={0,2}$/iu.test(encodedPrefix)
  ) {
    return false;
  }
  const prefix = Buffer.from(encodedPrefix, "base64");
  const ascii = prefix.toString("ascii");
  return (
    prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) ||
    ascii.startsWith("GIF87a") ||
    ascii.startsWith("GIF89a") ||
    (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") ||
    ascii.startsWith("BM") ||
    ascii.startsWith("II*\0") ||
    ascii.startsWith("MM\0*") ||
    ascii.trimStart().startsWith("<svg") ||
    (ascii.slice(4, 8) === "ftyp" &&
      /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/u.test(ascii.slice(8, 12)))
  );
}

/** 判断响应字符串是否是不得进入 QuickJS 的图片 data URL 或 Base64 字段。 */
function isProtectedResponseImage(
  value: string,
  fieldName: string | undefined
): boolean {
  if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) return true;
  const fieldIdentifiesImage = Boolean(
    fieldName &&
      IMAGE_BASE64_FIELD_NAMES.has(normalizeMediaFieldName(fieldName)) &&
      !/^https?:\/\//iu.test(value)
  );
  return fieldIdentifiesImage || hasBase64ImageSignature(value);
}

/** 响应流读取或有界传输解码失败；与管理员响应脚本错误分开观测。 */
export class ApiUpstreamResponseReadError extends Error {
  /** 保留内部 cause，但稳定消息不得暴露上游正文或地址。 */
  constructor(cause: unknown) {
    super("API 上游响应读取失败", { cause });
    this.name = "ApiUpstreamResponseReadError";
  }
}

/** 把 Retry-After 秒数或 HTTP-date 解析为 1-300 秒内部下限。 */
export function parseApiUpstreamRetryAfterSeconds(
  value: string | null,
  now: Date
): number | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const delta = Number(trimmed);
    if (!Number.isFinite(delta)) return undefined;
    return Math.min(300, Math.max(1, Math.ceil(delta)));
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  const deltaSeconds = Math.ceil((timestamp - now.getTime()) / 1_000);
  if (deltaSeconds <= 0) return undefined;
  return Math.min(300, deltaSeconds);
}

/** 只复制脚本契约允许读取的响应 Header。 */
function getSafeResponseHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(
    SAFE_RESPONSE_HEADER_NAMES.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    })
  );
}

/** 按 Content-Type 把有界响应正文解析为 JSON 或文本。 */
async function readApiUpstreamResponseBody(
  response: Response
): Promise<unknown> {
  const text = await response.text();
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) return text;
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * 运行非空响应脚本并返回严格标准结果。
 *
 * @param input 固定操作、响应许可、HTTP 响应、脚本、上下文与时钟。
 * @returns 标准状态及结合 Retry-After 后的下一次最早轮询秒数。
 * @throws 脚本输出非法、查询任务串线或响应读取失败时失败关闭。
 */
export async function parseApiUpstreamScriptedResponse(input: {
  operation: ApiUpstreamAdapterOperationId;
  permit: ApiUpstreamResponsePermit;
  response: Response;
  script: string;
  context: ApiUpstreamScriptContext;
  now?: Date;
}): Promise<{
  result: ApiUpstreamResponseResult;
  pollAfterSeconds?: number;
}> {
  let body: unknown;
  try {
    body = await readApiUpstreamResponseBody(input.response);
  } catch (error) {
    input.permit.release();
    throw new ApiUpstreamResponseReadError(error);
  }
  let protectedBody: ReturnType<typeof tokenizeApiUpstreamOpaqueValues>;
  try {
    protectedBody = tokenizeApiUpstreamOpaqueValues(
      body,
      isProtectedResponseImage
    );
  } catch (error) {
    input.permit.release();
    throw error;
  }
  const scriptInput = apiUpstreamResponseInputSchema.parse({
    statusCode: input.response.status,
    headers: getSafeResponseHeaders(input.response),
    body: protectedBody.value,
  });
  const rawResult = await runApiUpstreamResponseScript(
    input.permit,
    scriptInput,
    input.script,
    input.context,
    input.operation
  );
  assertApiUpstreamOpaqueValuesPreserved(rawResult, protectedBody.opaqueValues);
  const restoredResult = restoreApiUpstreamOpaqueValues(
    rawResult,
    protectedBody.opaqueValues
  );
  let result = apiUpstreamResponseResultForOperationSchema(
    input.operation
  ).parse(restoredResult);
  if (
    isApiUpstreamQueryOperation(input.operation) &&
    (result.status === "pending" || result.status === "processing")
  ) {
    if (result.taskId && result.taskId !== input.context.taskId) {
      throw new Error("API 上游查询响应返回了不同任务 ID");
    }
    if (!result.taskId && input.context.taskId) {
      result = { ...result, taskId: input.context.taskId };
    }
  }
  if (result.status !== "pending" && result.status !== "processing") {
    return { result };
  }
  const retryAfter = parseApiUpstreamRetryAfterSeconds(
    input.response.headers.get("retry-after"),
    input.now ?? new Date()
  );
  return {
    result,
    pollAfterSeconds: Math.max(
      result.pollAfterSeconds ?? API_UPSTREAM_DEFAULT_POLL_AFTER_SECONDS,
      retryAfter ?? 0
    ),
  };
}
