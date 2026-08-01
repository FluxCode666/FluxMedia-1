/**
 * API 上游脚本的宿主不透明值保护。
 *
 * 职责：把 Blob、data URL 或其他受保护媒体留在 Node 宿主，仅向 Worker 发送
 * 不可预测字符串令牌；脚本执行后验证每个令牌恰好保留一次并恢复原值。
 */
import { randomUUID } from "node:crypto";

const OPAQUE_TOKEN_PREFIX = "__fluxmedia_opaque_";

/** 不透明令牌与宿主真实值的只读映射。 */
export type ApiUpstreamOpaqueValues = ReadonlyMap<string, unknown>;

/** 媒体令牌被丢失、复制或伪造时的宿主稳定错误类型。 */
export class ApiUpstreamOpaqueValueError extends Error {
  /** 创建不包含真实媒体或令牌值的安全错误。 */
  constructor() {
    super("API 上游脚本破坏了不透明值令牌完整性");
    this.name = "ApiUpstreamOpaqueValueError";
  }
}

/** 判断未知值是否是非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 创建只在单次脚本作业内有效的不可预测媒体令牌。 */
export function createApiUpstreamOpaqueToken(): string {
  return `${OPAQUE_TOKEN_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

/**
 * 深度统计已知令牌，并拒绝伪造的同前缀令牌。
 *
 * @param value - 脚本输入或输出 JSON 树。
 * @param knownTokens - 当前作业由宿主生成的令牌集合。
 * @param counts - 就地累加每个已知令牌的出现次数。
 * @throws Error 出现宿主未签发的令牌时失败关闭。
 */
function countOpaqueTokens(
  value: unknown,
  knownTokens: ReadonlySet<string>,
  counts: Map<string, number>
): void {
  if (typeof value === "string") {
    if (knownTokens.has(value)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    } else if (knownTokens.size > 0 && value.startsWith(OPAQUE_TOKEN_PREFIX)) {
      throw new ApiUpstreamOpaqueValueError();
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) countOpaqueTokens(item, knownTokens, counts);
    return;
  }
  if (!isRecord(value)) return;
  for (const child of Object.values(value)) {
    countOpaqueTokens(child, knownTokens, counts);
  }
}

/**
 * 验证脚本不能丢失、复制或伪造宿主媒体令牌。
 *
 * @param value - 已令牌化的脚本输入或输出。
 * @param opaqueValues - 宿主签发的令牌映射。
 * @throws Error 任意令牌不是恰好出现一次时失败关闭。
 */
export function assertApiUpstreamOpaqueValuesPreserved(
  value: unknown,
  opaqueValues: ApiUpstreamOpaqueValues
): void {
  const knownTokens = new Set(opaqueValues.keys());
  const counts = new Map<string, number>();
  countOpaqueTokens(value, knownTokens, counts);
  for (const token of knownTokens) {
    if (counts.get(token) !== 1) {
      throw new ApiUpstreamOpaqueValueError();
    }
  }
}

/**
 * 把脚本输出中的令牌恢复为从未进入 Worker 的宿主值。
 *
 * @param value - 已验证的脚本输出。
 * @param opaqueValues - 令牌到真实媒体的映射。
 * @returns 保持 JSON 结构、恢复真实媒体叶子值的新树。
 */
export function restoreApiUpstreamOpaqueValues(
  value: unknown,
  opaqueValues: ApiUpstreamOpaqueValues
): unknown {
  if (typeof value === "string" && opaqueValues.has(value)) {
    return opaqueValues.get(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      restoreApiUpstreamOpaqueValues(item, opaqueValues)
    );
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      restoreApiUpstreamOpaqueValues(child, opaqueValues),
    ])
  );
}
