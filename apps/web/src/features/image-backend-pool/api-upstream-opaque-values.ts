/**
 * API 上游脚本的宿主不透明值保护。
 *
 * 职责：把 Blob、data URL 或其他受保护媒体留在 Node 宿主，仅向 Worker 发送
 * 不可预测字符串令牌；脚本执行后验证每个令牌恰好保留一次并恢复原值。
 */
import { randomUUID } from "node:crypto";
import {
  API_UPSTREAM_MAX_JSON_DEPTH,
  API_UPSTREAM_MAX_JSON_NODES,
} from "@repo/shared/image-backend/api-upstream-script-contract";

const OPAQUE_TOKEN_PREFIX = "__fluxmedia_opaque_";

/** 不透明令牌与宿主真实值的只读映射。 */
export type ApiUpstreamOpaqueValues = ReadonlyMap<string, unknown>;

/** 判断字符串叶子是否应留在宿主的不透明值选择器。 */
export type ApiUpstreamOpaqueValueSelector = (
  value: string,
  fieldName: string | undefined
) => boolean;

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

/** 遍历帧；显式栈避免恶意深层输入先耗尽 Node 主线程调用栈。 */
interface OpaqueTraversalFrame {
  readonly value: unknown;
  readonly depth: number;
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
function inspectOpaqueTree(
  value: unknown,
  knownTokens: ReadonlySet<string>,
  counts: Map<string, number>
): void {
  const stack: OpaqueTraversalFrame[] = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    nodes += 1;
    if (
      nodes > API_UPSTREAM_MAX_JSON_NODES ||
      frame.depth > API_UPSTREAM_MAX_JSON_DEPTH
    ) {
      throw new ApiUpstreamOpaqueValueError();
    }
    if (typeof frame.value === "string") {
      if (knownTokens.has(frame.value)) {
        counts.set(frame.value, (counts.get(frame.value) ?? 0) + 1);
      } else if (
        knownTokens.size > 0 &&
        frame.value.startsWith(OPAQUE_TOKEN_PREFIX)
      ) {
        throw new ApiUpstreamOpaqueValueError();
      }
      continue;
    }
    if (!frame.value || typeof frame.value !== "object") continue;
    if (visited.has(frame.value)) {
      throw new ApiUpstreamOpaqueValueError();
    }
    visited.add(frame.value);
    if (Array.isArray(frame.value)) {
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: frame.value[index],
          depth: frame.depth + 1,
        });
      }
      continue;
    }
    for (const [key, child] of Object.entries(frame.value).reverse()) {
      if (knownTokens.size > 0 && key.startsWith(OPAQUE_TOKEN_PREFIX)) {
        throw new ApiUpstreamOpaqueValueError();
      }
      stack.push({ value: child, depth: frame.depth + 1 });
    }
  }
}

/**
 * 把选中的字符串叶子替换为单次作业令牌。
 *
 * @param value - 尚未进入 Worker 的宿主 JSON 树。
 * @param shouldProtect - 根据叶子值和最近字段名判断是否保护。
 * @returns 令牌化副本及只留在宿主的真实值映射。
 * @throws ApiUpstreamOpaqueValueError 输入循环、过深或节点过多时失败关闭。
 */
export function tokenizeApiUpstreamOpaqueValues(
  value: unknown,
  shouldProtect: ApiUpstreamOpaqueValueSelector
): {
  value: unknown;
  opaqueValues: ApiUpstreamOpaqueValues;
} {
  inspectOpaqueTree(value, new Set(), new Map());
  const opaqueValues = new Map<string, unknown>();
  /** 递归复制已预检的有界树，并把命中的字符串叶子替换为新令牌。 */
  const tokenize = (
    current: unknown,
    fieldName: string | undefined
  ): unknown => {
    if (typeof current === "string" && shouldProtect(current, fieldName)) {
      const token = createApiUpstreamOpaqueToken();
      opaqueValues.set(token, current);
      return token;
    }
    if (Array.isArray(current)) {
      return current.map((child) => tokenize(child, fieldName));
    }
    if (!isRecord(current)) return current;
    return Object.fromEntries(
      Object.entries(current).map(([key, child]) => [key, tokenize(child, key)])
    );
  };
  return { value: tokenize(value, undefined), opaqueValues };
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
  inspectOpaqueTree(value, knownTokens, counts);
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
  inspectOpaqueTree(value, new Set(opaqueValues.keys()), new Map());
  /** 递归复制已预检的有界树，并把宿主签发的令牌恢复为真实值。 */
  const restore = (current: unknown): unknown => {
    if (typeof current === "string" && opaqueValues.has(current)) {
      return opaqueValues.get(current);
    }
    if (Array.isArray(current)) {
      return current.map((item) => restore(item));
    }
    if (!isRecord(current)) return current;
    return Object.fromEntries(
      Object.entries(current).map(([key, child]) => [key, restore(child)])
    );
  };
  return restore(value);
}
