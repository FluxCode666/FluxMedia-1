/**
 * API 上游脚本 Worker Thread 入口。
 *
 * 职责：在独立线程中为每个作业创建全新的 QuickJS Runtime/Context，执行同步
 * 管理员脚本，并只通过结构化克隆安全的字符串协议与主线程通信。
 */
import { parentPort } from "node:worker_threads";

import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

type WorkerJobKind = "validate" | "execute";

interface WorkerJobMessage {
  readonly type: "job";
  readonly id: string;
  readonly kind: WorkerJobKind;
  readonly script: string;
  readonly inputJson?: string;
  readonly contextJson?: string;
  readonly timeoutMs: number;
  readonly memoryLimitBytes: number;
  readonly stackLimitBytes: number;
  readonly maxScriptCharacters: number;
  readonly maxSerializedBytes: number;
}

interface WorkerSuccessMessage {
  readonly type: "result";
  readonly id: string;
  readonly ok: true;
  readonly outputJson?: string;
}

interface WorkerFailureMessage {
  readonly type: "result";
  readonly id: string;
  readonly ok: false;
  readonly code:
    | "invalid_script"
    | "execution_failed"
    | "invalid_output"
    | "worker_cleanup_failed";
  readonly replaceWorker: boolean;
}

const workerPort = parentPort;

/** 判断主线程消息是否满足最小作业协议，避免畸形消息触发宿主异常。 */
function isWorkerJobMessage(value: unknown): value is WorkerJobMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "job" &&
    typeof candidate.id === "string" &&
    (candidate.kind === "validate" || candidate.kind === "execute") &&
    typeof candidate.script === "string" &&
    typeof candidate.timeoutMs === "number" &&
    typeof candidate.memoryLimitBytes === "number" &&
    typeof candidate.stackLimitBytes === "number" &&
    typeof candidate.maxScriptCharacters === "number" &&
    typeof candidate.maxSerializedBytes === "number" &&
    (candidate.inputJson === undefined ||
      typeof candidate.inputJson === "string") &&
    (candidate.contextJson === undefined ||
      typeof candidate.contextJson === "string")
  );
}

/** 把管理员脚本包装为固定签名同步函数。 */
function buildTransformFunctionSource(script: string): string {
  return `(function transform(input, context) {\n"use strict";\nconst request = input;\nconst response = input;\n${script}\n})`;
}

/** 构造不注入任何 Node 能力或异步原语的 QuickJS 执行源码。 */
function buildExecutionSource(script: string): string {
  return `(() => {
  const input = JSON.parse(globalThis.__fluxInputJson);
  const context = JSON.parse(globalThis.__fluxContextJson);
  const deepFreeze = (value) => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };
  deepFreeze(context);
  globalThis.__fluxInputJson = undefined;
  globalThis.__fluxContextJson = undefined;
  globalThis.process = undefined;
  globalThis.require = undefined;
  globalThis.fetch = undefined;
  globalThis.XMLHttpRequest = undefined;
  globalThis.WebSocket = undefined;
  globalThis.setTimeout = undefined;
  globalThis.setInterval = undefined;
  globalThis.queueMicrotask = undefined;
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
  const output = transform(input, context);
  if (
    output !== null &&
    (typeof output === "object" || typeof output === "function") &&
    typeof output.then === "function"
  ) {
    throw new TypeError("Asynchronous script results are not supported");
  }
  return JSON.stringify(output);
})()`;
}

/**
 * 执行单个隔离作业并在所有路径显式销毁 QuickJS 资源。
 *
 * @param job - 已由主线程构造的字符串协议作业。
 * @returns 不携带源码、正文或堆栈的稳定结果。
 */
async function executeWorkerJob(
  job: WorkerJobMessage
): Promise<WorkerSuccessMessage | WorkerFailureMessage> {
  if (
    job.script.length > job.maxScriptCharacters ||
    (job.inputJson !== undefined &&
      Buffer.byteLength(job.inputJson) > job.maxSerializedBytes) ||
    (job.contextJson !== undefined &&
      Buffer.byteLength(job.contextJson) > job.maxSerializedBytes)
  ) {
    return {
      type: "result",
      id: job.id,
      ok: false,
      code: job.kind === "validate" ? "invalid_script" : "invalid_output",
      replaceWorker: false,
    };
  }

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  let context: ReturnType<typeof runtime.newContext> | undefined;
  let failureCode:
    | "invalid_script"
    | "execution_failed"
    | "invalid_output"
    | undefined;
  let outputJson: string | undefined;
  let cleanupFailed = false;

  try {
    runtime.setMemoryLimit(job.memoryLimitBytes);
    runtime.setMaxStackSize(job.stackLimitBytes);
    runtime.setInterruptHandler(
      shouldInterruptAfterDeadline(Date.now() + job.timeoutMs)
    );
    context = runtime.newContext();

    if (job.kind === "validate") {
      const result = context.evalCode(buildTransformFunctionSource(job.script));
      if (result.error) {
        result.error.dispose();
        failureCode = "invalid_script";
      } else {
        result.value.dispose();
      }
    } else if (job.inputJson === undefined || job.contextJson === undefined) {
      failureCode = "invalid_output";
    } else {
      const inputHandle = context.newString(job.inputJson);
      context.setProp(context.global, "__fluxInputJson", inputHandle);
      inputHandle.dispose();
      const contextHandle = context.newString(job.contextJson);
      context.setProp(context.global, "__fluxContextJson", contextHandle);
      contextHandle.dispose();

      const result = context.evalCode(buildExecutionSource(job.script));
      if (result.error) {
        result.error.dispose();
        failureCode = "execution_failed";
      } else {
        const dumped = context.dump(result.value);
        result.value.dispose();
        if (
          typeof dumped !== "string" ||
          Buffer.byteLength(dumped) > job.maxSerializedBytes
        ) {
          failureCode = "invalid_output";
        } else {
          outputJson = dumped;
        }
      }
    }
  } catch {
    failureCode =
      job.kind === "validate" ? "invalid_script" : "execution_failed";
  } finally {
    try {
      context?.dispose();
    } catch {
      cleanupFailed = true;
    }
    try {
      runtime.dispose();
    } catch {
      cleanupFailed = true;
    }
  }

  if (cleanupFailed) {
    return {
      type: "result",
      id: job.id,
      ok: false,
      code: "worker_cleanup_failed",
      replaceWorker: true,
    };
  }
  if (failureCode) {
    return {
      type: "result",
      id: job.id,
      ok: false,
      code: failureCode,
      replaceWorker: false,
    };
  }
  return { type: "result", id: job.id, ok: true, outputJson };
}

if (!workerPort) {
  throw new Error("API 上游脚本 Worker 只能由 Worker Thread 启动");
}

let processing = false;

workerPort.on("message", (message: unknown) => {
  if (!isWorkerJobMessage(message) || processing) {
    throw new Error("API 上游脚本 Worker 收到非法或并发作业");
  }
  processing = true;
  void executeWorkerJob(message)
    .then((result) => {
      workerPort.postMessage(result);
    })
    .finally(() => {
      processing = false;
    });
});

void getQuickJS().then(() => {
  workerPort.postMessage({ type: "ready" });
});
