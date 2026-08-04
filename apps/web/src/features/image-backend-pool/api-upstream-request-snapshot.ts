/**
 * API 上游真实请求正文的安全快照构造器。
 *
 * 使用方：通用 API 上游执行器。职责是在请求脚本完成、媒体值恢复后保留真实字段
 * 结构，同时移除签名查询串、凭据、Base64 与 Blob 原文，再交由生成任务持久化。
 */

import {
  type ApiUpstreamAdapterOperationId,
  type ApiUpstreamRequestSnapshot,
  apiUpstreamRequestSnapshotSchema,
} from "@repo/shared/image-backend/api-upstream-script-contract";

const MAX_SNAPSHOT_NODES = 2_000;
const MAX_SNAPSHOT_ARRAY_ITEMS = 100;
const MAX_SNAPSHOT_OBJECT_PROPERTIES = 200;
const MAX_SNAPSHOT_STRING_CHARACTERS = 12_000;
const SNAPSHOT_TEXT_BUDGET = 64 * 1024;
const REDACTED_VALUE = "[REDACTED]";
const TRUNCATED_VALUE = "[TRUNCATED]";
const SENSITIVE_FIELD_PATTERN =
  /(?:authorization|api[-_]?key|token|secret|password|credential|signature|cookie)/iu;

type SnapshotJsonValue =
  | null
  | boolean
  | number
  | string
  | SnapshotJsonValue[]
  | { [key: string]: SnapshotJsonValue };

type SnapshotBudget = {
  nodes: number;
  remainingCharacters: number;
  visited: WeakSet<object>;
};

/** 判断未知对象是否是普通 JSON 记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 消耗字符串预算；超长值保留前缀并明确标记截断。 */
function limitString(value: string, budget: SnapshotBudget): string {
  const allowed = Math.max(
    0,
    Math.min(MAX_SNAPSHOT_STRING_CHARACTERS, budget.remainingCharacters)
  );
  const limited =
    value.length <= allowed
      ? value
      : allowed <= TRUNCATED_VALUE.length + 1
        ? TRUNCATED_VALUE
        : `${value.slice(0, allowed - TRUNCATED_VALUE.length - 1)} ${TRUNCATED_VALUE}`;
  budget.remainingCharacters = Math.max(
    0,
    budget.remainingCharacters - limited.length
  );
  return limited;
}

/** 识别长 Base64 值，避免把图片、音视频或其他二进制编码写入数据库。 */
function looksLikeLongBase64(value: string): boolean {
  if (value.length < 512 || value.length % 4 !== 0) return false;
  const sampleLength = Math.min(value.length, 256);
  for (let index = 0; index < sampleLength; index += 1) {
    const code = value.charCodeAt(index);
    const isBase64Character =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47 ||
      code === 61;
    if (!isBase64Character) return false;
  }
  return true;
}

/** HTTP(S) URL 保留协议、域名和路径，所有查询参数与片段统一脱敏。 */
function sanitizeHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const queryMarker = parsed.search ? "?[REDACTED]" : "";
    const hashMarker = parsed.hash ? "#[REDACTED]" : "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${queryMarker}${hashMarker}`;
  } catch {
    return null;
  }
}

/** data URL 只保留媒体声明与编码长度，不持久化正文。 */
function sanitizeDataUrl(value: string): string | null {
  if (!value.toLowerCase().startsWith("data:")) return null;
  const separatorIndex = value.indexOf(",");
  if (separatorIndex < 0) return "data:[REDACTED]";
  const declaration = value.slice(0, separatorIndex);
  const payloadLength = value.length - separatorIndex - 1;
  return `${declaration},[REDACTED ${payloadLength} characters]`;
}

/** Blob/File 以媒体描述替代实际字节，保持 multipart 字段结构可读。 */
function describeBlob(value: Blob): SnapshotJsonValue {
  const possibleFile = value as Blob & { name?: unknown };
  const name =
    typeof possibleFile.name === "string" && possibleFile.name.trim()
      ? possibleFile.name.slice(0, 500)
      : null;
  return {
    type: name ? "File" : "Blob",
    ...(name ? { name } : {}),
    mimeType: value.type || "application/octet-stream",
    sizeBytes: value.size,
    data: REDACTED_VALUE,
  };
}

/**
 * 递归清洗最终请求 Body。
 *
 * @param value 请求脚本输出并恢复媒体后的未知值。
 * @param fieldName 当前字段名，用于凭据类字段脱敏。
 * @param budget 全局节点、循环与文本预算。
 * @returns 可安全 JSON 序列化的有界快照值。
 */
function sanitizeSnapshotValue(
  value: unknown,
  fieldName: string | undefined,
  budget: SnapshotBudget
): SnapshotJsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_SNAPSHOT_NODES) return TRUNCATED_VALUE;
  if (fieldName && SENSITIVE_FIELD_PATTERN.test(fieldName)) {
    return REDACTED_VALUE;
  }
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const dataUrl = sanitizeDataUrl(value);
    if (dataUrl) return limitString(dataUrl, budget);
    const httpUrl = sanitizeHttpUrl(value);
    if (httpUrl) return limitString(httpUrl, budget);
    if (looksLikeLongBase64(value)) {
      return `[REDACTED BASE64 ${value.length} characters]`;
    }
    return limitString(value, budget);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return describeBlob(value);
  }
  if (!value || typeof value !== "object") return null;
  if (budget.visited.has(value)) return "[REDACTED CIRCULAR VALUE]";
  budget.visited.add(value);
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_SNAPSHOT_ARRAY_ITEMS)
      .map((item) => sanitizeSnapshotValue(item, fieldName, budget));
    if (value.length > MAX_SNAPSHOT_ARRAY_ITEMS) {
      result.push(
        `[TRUNCATED ${value.length - MAX_SNAPSHOT_ARRAY_ITEMS} items]`
      );
    }
    budget.visited.delete(value);
    return result;
  }
  if (!isRecord(value)) {
    budget.visited.delete(value);
    return "[REDACTED NON-JSON VALUE]";
  }
  const entries = Object.entries(value);
  const result: Record<string, SnapshotJsonValue> = {};
  for (const [key, child] of entries.slice(0, MAX_SNAPSHOT_OBJECT_PROPERTIES)) {
    budget.remainingCharacters = Math.max(
      0,
      budget.remainingCharacters - key.length
    );
    result[key] = sanitizeSnapshotValue(child, key, budget);
  }
  if (entries.length > MAX_SNAPSHOT_OBJECT_PROPERTIES) {
    result._truncated = `${entries.length - MAX_SNAPSHOT_OBJECT_PROPERTIES} properties`;
  }
  budget.visited.delete(value);
  return result;
}

/**
 * 创建最终 API 上游请求 Body 的安全快照。
 *
 * @param input 实际操作、编码类型和脚本处理后的最终 Body。
 * @returns 通过共享大小与 JSON 契约校验的快照；异常超限时返回明确占位。
 */
export function createApiUpstreamRequestSnapshot(input: {
  operation: ApiUpstreamAdapterOperationId;
  contentType: "application/json" | "multipart/form-data";
  body: unknown;
}): ApiUpstreamRequestSnapshot {
  const snapshot = {
    operation: input.operation,
    contentType: input.contentType,
    body: sanitizeSnapshotValue(input.body, undefined, {
      nodes: 0,
      remainingCharacters: SNAPSHOT_TEXT_BUDGET,
      visited: new WeakSet(),
    }),
  };
  const parsed = apiUpstreamRequestSnapshotSchema.safeParse(snapshot);
  if (parsed.success) return parsed.data;
  return apiUpstreamRequestSnapshotSchema.parse({
    operation: input.operation,
    contentType: input.contentType,
    body: "[TRUNCATED: request snapshot exceeded storage limit]",
  });
}
