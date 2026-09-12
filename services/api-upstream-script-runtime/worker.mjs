/**
 * API 上游脚本 Worker Thread 的生产入口。
 *
 * 职责：在独立线程中为每个作业创建全新的 QuickJS Runtime/Context，执行同步
 * 管理员脚本，并只通过结构化克隆安全的字符串协议与主线程通信。使用原生 ESM，
 * 确保 standalone 容器中的 Node 无需 TypeScript loader 即可启动。
 */
import { parentPort } from "node:worker_threads";

import { getQuickJS } from "quickjs-emscripten";

const workerPort = parentPort;

/** 判断主线程消息是否满足最小作业协议，避免畸形消息触发宿主异常。 */
function isWorkerJobMessage(value) {
  if (!value || typeof value !== "object") return false;
  return (
    value.type === "job" &&
    typeof value.id === "string" &&
    (value.kind === "validate" || value.kind === "execute") &&
    typeof value.script === "string" &&
    typeof value.timeoutMs === "number" &&
    typeof value.memoryLimitBytes === "number" &&
    typeof value.stackLimitBytes === "number" &&
    typeof value.maxScriptCharacters === "number" &&
    typeof value.maxSerializedBytes === "number" &&
    (value.inputJson === undefined || typeof value.inputJson === "string") &&
    (value.contextJson === undefined || typeof value.contextJson === "string")
  );
}

/**
 * 构造只计算当前 Worker 线程 CPU 用量的 QuickJS 中断条件。
 *
 * @param {number} timeoutMs - 单个脚本允许消耗的线程 CPU 毫秒数。
 * @returns {() => boolean} 达到 CPU 预算后返回 true 的同步中断函数。
 */
function shouldInterruptAfterThreadCpuBudget(timeoutMs) {
  const startedUsage = process.threadCpuUsage();
  const budgetMicroseconds = timeoutMs * 1_000;
  return () => {
    const elapsedUsage = process.threadCpuUsage(startedUsage);
    return elapsedUsage.user + elapsedUsage.system >= budgetMicroseconds;
  };
}

/** 把管理员脚本包装为固定签名同步函数。 */
function buildTransformFunctionSource(script) {
  return `(function transform(input, context) {\n"use strict";\nconst request = input;\nconst response = input;\n${script}\n})`;
}

/** 构造不注入任何 Node 能力或异步原语的 QuickJS 执行源码。 */
function buildExecutionSource(script) {
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
 * @param {Record<string, unknown>} job - 已由主线程构造的字符串协议作业。
 * @returns {Promise<Record<string, unknown>>} 不携带源码、正文或堆栈的稳定结果。
 */
async function executeWorkerJob(job) {
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
  let context;
  let failureCode;
  let outputJson;
  let cleanupFailed = false;

  try {
    runtime.setMemoryLimit(job.memoryLimitBytes);
    runtime.setMaxStackSize(job.stackLimitBytes);
    context = runtime.newContext();

    if (job.kind === "validate") {
      // WHY：50ms 只约束管理员脚本编译与执行，不计入冷启动时的 WASM、Runtime
      // 和 Context 初始化；整个 Worker 作业另有宿主墙钟看门狗兜底。
      runtime.setInterruptHandler(
        shouldInterruptAfterThreadCpuBudget(job.timeoutMs)
      );
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

      runtime.setInterruptHandler(
        shouldInterruptAfterThreadCpuBudget(job.timeoutMs)
      );
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

workerPort.on("message", (message) => {
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
