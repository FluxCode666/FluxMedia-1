/**
 * API 账号请求处理脚本的 QuickJS 隔离运行时。
 *
 * 职责：在不暴露 Node、网络、文件、凭据或请求头的独立 WebAssembly VM 中，同步
 * 执行管理员配置的请求体转换，并校验 CPU、内存、输入输出与媒体宿主令牌不变量。
 * 使用方：API Images/Videos 上游适配器与成员保存时的脚本语法校验。
 */
import { randomUUID } from "node:crypto";

import { apiRequestTransformScriptSchema } from "@repo/shared/image-backend/api-upstream-adaptation";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

const SCRIPT_EXECUTION_TIMEOUT_MS = 50;
const SCRIPT_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const SCRIPT_STACK_LIMIT_BYTES = 512 * 1024;
const SCRIPT_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;
const SCRIPT_MAX_DEPTH = 16;
const SCRIPT_MAX_NODES = 10_000;
const OPAQUE_TOKEN_PREFIX = "__fluxmedia_opaque_";
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 请求处理脚本可见的固定操作类型。 */
export type ApiRequestTransformOperation =
  | "images.generate"
  | "images.edit"
  | "videos.generate";

/** 请求处理脚本可见的脱敏、只读上下文。 */
export interface ApiRequestTransformContext {
  operation: ApiRequestTransformOperation;
  contentType: "application/json" | "multipart/form-data";
  platformModelId: string;
  upstreamModelId: string;
}

/** QuickJS 请求处理失败；消息稳定且绝不包含请求体、脚本或凭据。 */
export class ApiRequestTransformError extends Error {
  /** 创建可安全返回给成员调度层的脚本错误。 */
  constructor(
    readonly code: "invalid_script" | "execution_failed" | "invalid_output"
  ) {
    super(
      code === "invalid_script"
        ? "API 账号请求处理脚本语法无效"
        : code === "execution_failed"
          ? "API 账号请求处理脚本执行失败"
          : "API 账号请求处理脚本返回了非法请求体"
    );
    this.name = "ApiRequestTransformError";
  }
}

/** 创建只在宿主内保存真实媒体值的不可预测脚本令牌。 */
export function createApiRequestOpaqueToken(): string {
  return `${OPAQUE_TOKEN_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

/** 判断未知值是否是 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 构造用户脚本函数源码；脚本正文可直接使用 return。 */
function buildTransformFunctionSource(script: string): string {
  return `(function transform(request, context) {\n"use strict";\n${script}\n})`;
}

/** 构造执行源码；QuickJS 全局不注入任何宿主函数或模块加载器。 */
function buildExecutionSource(script: string): string {
  return `(() => {
  const request = JSON.parse(globalThis.__fluxRequestJson);
  const context = Object.freeze(JSON.parse(globalThis.__fluxContextJson));
  globalThis.__fluxRequestJson = undefined;
  globalThis.__fluxContextJson = undefined;
  globalThis.process = undefined;
  globalThis.require = undefined;
  globalThis.fetch = undefined;
  globalThis.XMLHttpRequest = undefined;
  globalThis.WebSocket = undefined;
  globalThis.setTimeout = undefined;
  globalThis.setInterval = undefined;
  globalThis.Promise = undefined;
  globalThis.Date = undefined;
  Math.random = undefined;
  globalThis.eval = undefined;
  Object.defineProperty(Function.prototype, "constructor", {
    value: undefined,
    configurable: false,
    writable: false,
  });
  globalThis.Function = undefined;
  const transform = ${buildTransformFunctionSource(script)};
  const output = transform(request, context);
  if (
    output !== null &&
    (typeof output === "object" || typeof output === "function") &&
    typeof output.then === "function"
  ) {
    throw new TypeError("Asynchronous transform results are not supported");
  }
  return JSON.stringify(output);
})()`;
}

/**
 * 校验 JSON 树深度、节点数和危险键，避免脚本输出放大或原型污染进入宿主逻辑。
 */
function assertSafeJsonTree(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > SCRIPT_MAX_NODES || depth > SCRIPT_MAX_DEPTH) {
      throw new ApiRequestTransformError("invalid_output");
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      if (BLOCKED_KEYS.has(key)) {
        throw new ApiRequestTransformError("invalid_output");
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

/** 统计全部已知宿主媒体令牌；未知字符串无法关联宿主值，因此保持普通文本。 */
function countOpaqueTokens(
  value: unknown,
  knownTokens: ReadonlySet<string>,
  counts: Map<string, number>
): void {
  if (typeof value === "string" && knownTokens.has(value)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
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

/** 确保每个宿主媒体值在脚本输入或输出中恰好出现一次。 */
function assertOpaqueTokensPreserved(
  value: unknown,
  opaqueValues: ReadonlyMap<string, unknown>
): void {
  const knownTokens = new Set(opaqueValues.keys());
  const counts = new Map<string, number>();
  countOpaqueTokens(value, knownTokens, counts);
  for (const token of knownTokens) {
    if (counts.get(token) !== 1) {
      throw new ApiRequestTransformError("invalid_output");
    }
  }
}

/** 把脚本输出中的宿主令牌恢复为未进入 QuickJS 的 Blob 或 data URL。 */
function restoreOpaqueValues(
  value: unknown,
  opaqueValues: ReadonlyMap<string, unknown>
): unknown {
  if (typeof value === "string" && opaqueValues.has(value)) {
    return opaqueValues.get(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => restoreOpaqueValues(item, opaqueValues));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      restoreOpaqueValues(child, opaqueValues),
    ])
  );
}

/**
 * 在 QuickJS 中仅编译管理员脚本，不使用真实请求执行。
 *
 * @param rawScript - 管理端提交的脚本正文。
 * @throws ApiRequestTransformError 脚本超长或语法非法时拒绝保存。
 */
export async function validateApiRequestTransformScript(
  rawScript: string
): Promise<void> {
  const parsed = apiRequestTransformScriptSchema.safeParse(rawScript);
  if (!parsed.success) throw new ApiRequestTransformError("invalid_script");
  if (!parsed.data) return;

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(SCRIPT_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(SCRIPT_STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + SCRIPT_EXECUTION_TIMEOUT_MS)
  );
  const context = runtime.newContext();
  try {
    const result = context.evalCode(buildTransformFunctionSource(parsed.data));
    if (result.error) {
      result.error.dispose();
      throw new ApiRequestTransformError("invalid_script");
    }
    result.value.dispose();
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

/**
 * 在受限 QuickJS 中转换一个账号即将发送的请求体。
 *
 * @param request - JSON 安全的标准请求；大媒体应先替换为宿主令牌。
 * @param rawScript - 账号保存的同步脚本正文；空脚本保持原请求。
 * @param scriptContext - 不含身份、凭据、URL 或 Header 的只读上下文。
 * @param opaqueValues - 令牌到 Blob/data URL 的宿主映射；脚本不得丢失或复制。
 * @returns 经严格校验并恢复媒体值的普通请求对象。
 * @throws ApiRequestTransformError 超时、超内存、异常、非法输出或媒体令牌破坏时失败关闭。
 */
export async function applyApiRequestTransformScript(
  request: Record<string, unknown>,
  rawScript: string,
  scriptContext: ApiRequestTransformContext,
  opaqueValues: ReadonlyMap<string, unknown> = new Map()
): Promise<Record<string, unknown>> {
  const parsed = apiRequestTransformScriptSchema.safeParse(rawScript);
  if (!parsed.success) throw new ApiRequestTransformError("invalid_script");
  assertSafeJsonTree(request);
  assertOpaqueTokensPreserved(request, opaqueValues);
  if (!parsed.data) {
    return restoreOpaqueValues(request, opaqueValues) as Record<
      string,
      unknown
    >;
  }

  const requestJson = JSON.stringify(request);
  const contextJson = JSON.stringify(scriptContext);
  if (
    Buffer.byteLength(requestJson) > SCRIPT_MAX_SERIALIZED_BYTES ||
    Buffer.byteLength(contextJson) > SCRIPT_MAX_SERIALIZED_BYTES
  ) {
    throw new ApiRequestTransformError("invalid_output");
  }

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(SCRIPT_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(SCRIPT_STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + SCRIPT_EXECUTION_TIMEOUT_MS)
  );
  const context = runtime.newContext();
  let serializedOutput: unknown;
  try {
    const requestHandle = context.newString(requestJson);
    context.setProp(context.global, "__fluxRequestJson", requestHandle);
    requestHandle.dispose();
    const contextHandle = context.newString(contextJson);
    context.setProp(context.global, "__fluxContextJson", contextHandle);
    contextHandle.dispose();

    const result = context.evalCode(buildExecutionSource(parsed.data));
    if (result.error) {
      result.error.dispose();
      throw new ApiRequestTransformError("execution_failed");
    }
    serializedOutput = context.dump(result.value);
    result.value.dispose();
  } finally {
    context.dispose();
    runtime.dispose();
  }

  if (
    typeof serializedOutput !== "string" ||
    Buffer.byteLength(serializedOutput) > SCRIPT_MAX_SERIALIZED_BYTES
  ) {
    throw new ApiRequestTransformError("invalid_output");
  }
  let output: unknown;
  try {
    output = JSON.parse(serializedOutput) as unknown;
  } catch {
    throw new ApiRequestTransformError("invalid_output");
  }
  if (!isRecord(output)) {
    throw new ApiRequestTransformError("invalid_output");
  }
  assertSafeJsonTree(output);
  assertOpaqueTokensPreserved(output, opaqueValues);
  return restoreOpaqueValues(output, opaqueValues) as Record<string, unknown>;
}
