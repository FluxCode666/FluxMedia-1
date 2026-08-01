/**
 * API 上游脚本的主线程宿主执行器。
 *
 * 职责：在 Worker 边界外校验普通 JSON、序列化脱敏上下文，并将语法验证、请求
 * 与响应执行统一交给进程单例 Pool；本模块绝不创建 QuickJS Runtime。
 */
import type { ApiUpstreamAdapterOperationId } from "@repo/shared/image-backend/api-upstream-script-contract";
import {
  API_UPSTREAM_MAX_JSON_DEPTH,
  API_UPSTREAM_MAX_JSON_NODES,
  API_UPSTREAM_MAX_SCRIPT_CHARACTERS,
  API_UPSTREAM_MAX_SERIALIZED_BYTES,
} from "@repo/shared/image-backend/api-upstream-script-contract";

import {
  type ApiUpstreamResponsePermit,
  type ApiUpstreamScriptJobPriority,
  ApiUpstreamScriptPoolError,
  ensureApiUpstreamScriptPool,
} from "./api-upstream-script-pool";

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 主线程执行器向上层暴露的稳定失败码。 */
export type ApiUpstreamScriptRuntimeErrorCode =
  | "invalid_script"
  | "execution_failed"
  | "invalid_output"
  | "runtime_saturated"
  | "runtime_closed";

/** 不包含脚本、正文、Worker 堆栈或内部路径的稳定运行时错误。 */
export class ApiUpstreamScriptRuntimeError extends Error {
  readonly code: ApiUpstreamScriptRuntimeErrorCode;
  readonly retryAfterSeconds?: number;

  /**
   * @param code - 供媒体执行器按类型处理的稳定错误码。
   * @param retryAfterSeconds - 饱和时建议下游重试的秒数。
   */
  constructor(
    code: ApiUpstreamScriptRuntimeErrorCode,
    retryAfterSeconds?: number
  ) {
    super(
      code === "invalid_script"
        ? "API 上游处理脚本语法无效"
        : code === "invalid_output"
          ? "API 上游处理脚本输出无效"
          : code === "runtime_saturated"
            ? "API 上游处理脚本运行时繁忙"
            : "API 上游处理脚本执行失败"
    );
    this.name = "ApiUpstreamScriptRuntimeError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 脚本执行所需的脱敏调度元数据。 */
export interface RunApiUpstreamScriptOptions {
  readonly operation: ApiUpstreamAdapterOperationId;
  readonly stage: "request" | "response";
  readonly priority: Exclude<ApiUpstreamScriptJobPriority, "response">;
}

/**
 * 校验 JSON 树的深度、节点、危险键和循环引用。
 *
 * @param value - Worker 输入或解析后的输出。
 * @param failureCode - 失败时区分输入配置与脚本输出。
 * @throws ApiUpstreamScriptRuntimeError 超出资源边界或含危险结构时失败关闭。
 */
function assertSafeJsonTree(
  value: unknown,
  failureCode: "execution_failed" | "invalid_output"
): void {
  let nodes = 0;
  const visited = new WeakSet<object>();
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (
      nodes > API_UPSTREAM_MAX_JSON_NODES ||
      depth > API_UPSTREAM_MAX_JSON_DEPTH
    ) {
      throw new ApiUpstreamScriptRuntimeError(failureCode);
    }
    if (!current || typeof current !== "object") return;
    if (visited.has(current)) {
      throw new ApiUpstreamScriptRuntimeError(failureCode);
    }
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (BLOCKED_KEYS.has(key)) {
        throw new ApiUpstreamScriptRuntimeError(failureCode);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

/** 把 Pool 内部故障收敛为执行器稳定错误，墙钟或 Worker 故障均不可重试脚本。 */
function mapPoolError(error: unknown): ApiUpstreamScriptRuntimeError {
  if (!(error instanceof ApiUpstreamScriptPoolError)) {
    return new ApiUpstreamScriptRuntimeError("execution_failed");
  }
  if (
    error.code === "invalid_script" ||
    error.code === "execution_failed" ||
    error.code === "invalid_output" ||
    error.code === "runtime_saturated" ||
    error.code === "runtime_closed"
  ) {
    return new ApiUpstreamScriptRuntimeError(
      error.code,
      error.retryAfterSeconds
    );
  }
  return new ApiUpstreamScriptRuntimeError("execution_failed");
}

/** 校验脚本长度并规范空白脚本。 */
function normalizeScript(rawScript: string): string {
  if (rawScript.length > API_UPSTREAM_MAX_SCRIPT_CHARACTERS) {
    throw new ApiUpstreamScriptRuntimeError("invalid_script");
  }
  return rawScript.trim() ? rawScript : "";
}

/**
 * 在生产 Worker 中只编译一个非空脚本，用于保存时的第二次语法校验。
 *
 * @param rawScript - 管理员脚本正文。
 * @param operation - 六个适配操作之一，仅作脱敏调度维度。
 * @param stage - 请求或响应阶段。
 */
export async function validateApiUpstreamScript(
  rawScript: string,
  operation: ApiUpstreamAdapterOperationId,
  stage: "request" | "response"
): Promise<void> {
  const script = normalizeScript(rawScript);
  if (!script) return;
  try {
    const pool = await ensureApiUpstreamScriptPool();
    await pool.run({
      kind: "validate",
      script,
      priority: "validation",
      operation,
      stage,
    });
  } catch (error) {
    throw mapPoolError(error);
  }
}

/**
 * 在低优先级 Worker 队列中执行请求、保存夹具或管理测试脚本。
 *
 * @param input - 已在宿主令牌化的普通 JSON 输入。
 * @param rawScript - 非空同步脚本；空脚本原样返回输入。
 * @param scriptContext - 不含凭据、URL、Header 或媒体的上下文。
 * @param options - 操作、阶段与低优先级类别。
 * @returns 经 JSON 解析及安全树校验的脚本结果。
 */
export async function runApiUpstreamScript(
  input: unknown,
  rawScript: string,
  scriptContext: Readonly<Record<string, unknown>>,
  options: RunApiUpstreamScriptOptions
): Promise<unknown> {
  const script = normalizeScript(rawScript);
  assertSafeJsonTree(input, "execution_failed");
  assertSafeJsonTree(scriptContext, "execution_failed");
  if (!script) return input;

  let inputJson: string;
  let contextJson: string;
  try {
    inputJson = JSON.stringify(input);
    contextJson = JSON.stringify(scriptContext);
  } catch {
    throw new ApiUpstreamScriptRuntimeError("execution_failed");
  }
  if (
    Buffer.byteLength(inputJson) > API_UPSTREAM_MAX_SERIALIZED_BYTES ||
    Buffer.byteLength(contextJson) > API_UPSTREAM_MAX_SERIALIZED_BYTES
  ) {
    throw new ApiUpstreamScriptRuntimeError("execution_failed");
  }

  let outputJson: string | undefined;
  try {
    const pool = await ensureApiUpstreamScriptPool();
    outputJson = await pool.run({
      kind: "execute",
      script,
      inputJson,
      contextJson,
      priority: options.priority,
      operation: options.operation,
      stage: options.stage,
    });
  } catch (error) {
    throw mapPoolError(error);
  }
  if (
    outputJson === undefined ||
    Buffer.byteLength(outputJson) > API_UPSTREAM_MAX_SERIALIZED_BYTES
  ) {
    throw new ApiUpstreamScriptRuntimeError("invalid_output");
  }
  let output: unknown;
  try {
    output = JSON.parse(outputJson) as unknown;
  } catch {
    throw new ApiUpstreamScriptRuntimeError("invalid_output");
  }
  assertSafeJsonTree(output, "invalid_output");
  return output;
}

/**
 * 在外呼前取得未来响应许可。
 *
 * @returns 可恰好运行一次高优先级响应脚本的一次性许可。
 */
export async function reserveApiUpstreamResponsePermit(): Promise<ApiUpstreamResponsePermit> {
  try {
    const pool = await ensureApiUpstreamScriptPool();
    return await pool.reserveResponsePermit();
  } catch (error) {
    throw mapPoolError(error);
  }
}

/**
 * 使用已预留许可运行真实响应脚本；完成或失败都会自动释放许可。
 *
 * @param permit - 外呼前取得且尚未释放的 Pool 级许可。
 * @param input - 令牌化的上游响应安全视图。
 * @param rawScript - 响应处理脚本。
 * @param scriptContext - 脱敏只读上下文。
 * @param operation - 当前适配操作。
 * @returns 经安全 JSON 解析的统一响应候选值。
 */
export async function runApiUpstreamResponseScript(
  permit: ApiUpstreamResponsePermit,
  input: unknown,
  rawScript: string,
  scriptContext: Readonly<Record<string, unknown>>,
  operation: ApiUpstreamAdapterOperationId
): Promise<unknown> {
  const script = normalizeScript(rawScript);
  assertSafeJsonTree(input, "execution_failed");
  assertSafeJsonTree(scriptContext, "execution_failed");
  if (!script) {
    permit.release();
    return input;
  }

  const inputJson = JSON.stringify(input);
  const contextJson = JSON.stringify(scriptContext);
  if (
    Buffer.byteLength(inputJson) > API_UPSTREAM_MAX_SERIALIZED_BYTES ||
    Buffer.byteLength(contextJson) > API_UPSTREAM_MAX_SERIALIZED_BYTES
  ) {
    permit.release();
    throw new ApiUpstreamScriptRuntimeError("execution_failed");
  }
  let outputJson: string | undefined;
  try {
    outputJson = await permit.run({
      kind: "execute",
      script,
      inputJson,
      contextJson,
      operation,
    });
  } catch (error) {
    throw mapPoolError(error);
  }
  if (
    !outputJson ||
    Buffer.byteLength(outputJson) > API_UPSTREAM_MAX_SERIALIZED_BYTES
  ) {
    throw new ApiUpstreamScriptRuntimeError("invalid_output");
  }
  let output: unknown;
  try {
    output = JSON.parse(outputJson) as unknown;
  } catch {
    throw new ApiUpstreamScriptRuntimeError("invalid_output");
  }
  assertSafeJsonTree(output, "invalid_output");
  return output;
}
