/**
 * API 上游 QuickJS Worker 的部署探针。
 *
 * 使用方：迁移预检与 standalone/容器 smoke 共用生产 Worker
 * 字符串协议。本模块不访问数据库、网络、凭据或媒体正文。
 */
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

const DEFAULT_MEMORY_LIMIT_MB = 32;
const DEFAULT_STACK_LIMIT_KB = 512;
const DEFAULT_WORKER_COUNT = 1;
const MIN_MEMORY_LIMIT_MB = 16;
const MAX_MEMORY_LIMIT_MB = 128;
const MIN_STACK_LIMIT_KB = 256;
const MAX_STACK_LIMIT_KB = 2_048;
const MIN_WORKER_COUNT = 1;
const MAX_WORKER_COUNT = 8;
const SCRIPT_TIMEOUT_MS = 50;
const WORKER_TIMEOUT_MS = 10_000;

/** 脚本源码最大 UTF-16 代码单元数，与共享运行契约一致。 */
export const API_UPSTREAM_PROBE_MAX_SCRIPT_CHARACTERS = 32_768;

/** 单个普通 JSON 输入或输出的最大字节数。 */
export const API_UPSTREAM_PROBE_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

/** 只暴露稳定代码的部署探针错误。 */
export class ApiUpstreamWorkerProbeError extends Error {
  /**
   * @param {"invalid_runtime_config" | "worker_start_failed" | "worker_job_failed" | "worker_timeout"} code
   *   供预检和 smoke 进行稳定分类的错误码。
   */
  constructor(code) {
    super("API 上游 Worker 部署探针失败");
    this.name = "ApiUpstreamWorkerProbeError";
    this.code = code;
  }
}

/**
 * 解析单个有界十进制整数。
 *
 * @param {string | undefined} rawValue 环境变量原值。
 * @param {number} fallback 未配置时的默认值。
 * @param {number} minimum 闭区间下界。
 * @param {number} maximum 闭区间上界。
 * @returns {number} 已验证的整数。
 */
function parseBoundedInteger(rawValue, fallback, minimum, maximum) {
  if (rawValue === undefined) return fallback;
  if (!/^[0-9]+$/.test(rawValue)) {
    throw new ApiUpstreamWorkerProbeError("invalid_runtime_config");
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiUpstreamWorkerProbeError("invalid_runtime_config");
  }
  return parsed;
}

/**
 * 从部署环境解析与 Web 进程相同的 QuickJS 资源上限。
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment
 *   当前部署环境。
 * @returns {{ workerCount: number, memoryLimitBytes: number, stackLimitBytes: number }} Worker 作业边界。
 * @throws {ApiUpstreamWorkerProbeError} 格式非法或越界时失败关闭。
 */
export function parseApiUpstreamProbeRuntimeConfig(environment = process.env) {
  const workerCount = parseBoundedInteger(
    environment.API_UPSTREAM_SCRIPT_WORKER_COUNT,
    DEFAULT_WORKER_COUNT,
    MIN_WORKER_COUNT,
    MAX_WORKER_COUNT
  );
  const memoryLimitMb = parseBoundedInteger(
    environment.API_UPSTREAM_SCRIPT_MEMORY_LIMIT_MB,
    DEFAULT_MEMORY_LIMIT_MB,
    MIN_MEMORY_LIMIT_MB,
    MAX_MEMORY_LIMIT_MB
  );
  const stackLimitKb = parseBoundedInteger(
    environment.API_UPSTREAM_SCRIPT_STACK_LIMIT_KB,
    DEFAULT_STACK_LIMIT_KB,
    MIN_STACK_LIMIT_KB,
    MAX_STACK_LIMIT_KB
  );
  return {
    workerCount,
    memoryLimitBytes: memoryLimitMb * 1024 * 1024,
    stackLimitBytes: stackLimitKb * 1024,
  };
}

/**
 * 判断 Worker 消息是否为当前作业的完成结果。
 *
 * @param {unknown} message Worker 返回的未信任消息。
 * @param {string} jobId 当前作业的随机 ID。
 * @returns {boolean} 消息形状与 ID 均匹配时返回 true。
 */
function isJobResult(message, jobId) {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    message.type === "result" &&
    message.id === jobId &&
    typeof message.ok === "boolean"
  );
}

/**
 * 启动一个真实生产 Worker，并串行执行部署探针作业。
 *
 * 每个实例只用于短命预检或 smoke；调用方必须在 finally 中关闭。
 */
export class ApiUpstreamWorkerProbe {
  /**
   * @param {{ workerUrl?: URL, environment?: NodeJS.ProcessEnv | Record<string, string | undefined> }} options
   *   可注入的 Worker 入口与资源环境。
   */
  constructor(options = {}) {
    this.runtimeConfig = parseApiUpstreamProbeRuntimeConfig(
      options.environment ?? process.env
    );
    this.worker = new Worker(
      options.workerUrl ??
        new URL(
          "../src/features/image-backend-pool/api-upstream-script-worker.mjs",
          import.meta.url
        )
    );
    this.ready = this.waitUntilReady();
    this.closed = false;
  }

  /**
   * 等待 QuickJS WASM 初始化。
   *
   * @returns {Promise<void>} Worker 发出 ready 后完成。
   * @sideEffects 临时注册 Worker 消息、错误、退出监听和超时器。
   * @throws {ApiUpstreamWorkerProbeError} 启动失败或超时时不传播原始错误。
   */
  waitUntilReady() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ApiUpstreamWorkerProbeError("worker_timeout"));
      }, WORKER_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        this.worker.off("exit", onExit);
      };
      const onMessage = (message) => {
        if (
          !message ||
          typeof message !== "object" ||
          message.type !== "ready"
        ) {
          return;
        }
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new ApiUpstreamWorkerProbeError("worker_start_failed"));
      };
      const onExit = () => {
        cleanup();
        reject(new ApiUpstreamWorkerProbeError("worker_start_failed"));
      };
      this.worker.on("message", onMessage);
      this.worker.once("error", onError);
      this.worker.once("exit", onExit);
    });
  }

  /**
   * 在 QuickJS 中编译脚本函数体。
   *
   * @param {string} script 不包凭据的管理员脚本源码。
   * @returns {Promise<void>} 编译成功时完成。
   */
  async validate(script) {
    await this.runJob({ kind: "validate", script });
  }

  /**
   * 在 QuickJS 中执行一次脱敏 JSON 作业。
   *
   * @param {string} script 脚本函数体。
   * @param {unknown} input JSON 输入。
   * @param {Record<string, unknown>} context 脱敏上下文。
   * @returns {Promise<unknown>} 脚本返回的 JSON 值。
   */
  async execute(script, input, context) {
    const outputJson = await this.runJob({
      kind: "execute",
      script,
      inputJson: JSON.stringify(input),
      contextJson: JSON.stringify(context),
    });
    if (typeof outputJson !== "string") {
      throw new ApiUpstreamWorkerProbeError("worker_job_failed");
    }
    try {
      return JSON.parse(outputJson);
    } catch {
      throw new ApiUpstreamWorkerProbeError("worker_job_failed");
    }
  }

  /**
   * 发送一个作业并只接收对应 ID 的结果。
   *
   * @param {Record<string, unknown>} job 不含资源限制和 ID 的作业负载。
   * @returns {Promise<unknown>} Worker 返回的可选 outputJson。
   * @sideEffects 向独立 Worker 发送一条消息并临时注册监听器。
   * @throws {ApiUpstreamWorkerProbeError} Worker 拒绝、退出或超时时失败关闭。
   */
  async runJob(job) {
    if (this.closed) {
      throw new ApiUpstreamWorkerProbeError("worker_job_failed");
    }
    await this.ready;
    const jobId = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ApiUpstreamWorkerProbeError("worker_timeout"));
      }, WORKER_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        this.worker.off("exit", onExit);
      };
      const onMessage = (message) => {
        if (!isJobResult(message, jobId)) return;
        cleanup();
        if (!message.ok) {
          reject(new ApiUpstreamWorkerProbeError("worker_job_failed"));
          return;
        }
        resolve(message.outputJson);
      };
      const onError = () => {
        cleanup();
        reject(new ApiUpstreamWorkerProbeError("worker_job_failed"));
      };
      const onExit = () => {
        cleanup();
        reject(new ApiUpstreamWorkerProbeError("worker_job_failed"));
      };
      this.worker.on("message", onMessage);
      this.worker.once("error", onError);
      this.worker.once("exit", onExit);
      this.worker.postMessage({
        type: "job",
        id: jobId,
        ...job,
        timeoutMs: SCRIPT_TIMEOUT_MS,
        memoryLimitBytes: this.runtimeConfig.memoryLimitBytes,
        stackLimitBytes: this.runtimeConfig.stackLimitBytes,
        maxScriptCharacters: API_UPSTREAM_PROBE_MAX_SCRIPT_CHARACTERS,
        maxSerializedBytes: API_UPSTREAM_PROBE_MAX_SERIALIZED_BYTES,
      });
    });
  }

  /**
   * 终止短命 Worker。
   *
   * @returns {Promise<void>} Worker Thread 已退出时完成。
   * @sideEffects 首次调用终止 Worker；重复调用无副作用。
   */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.worker.terminate();
  }
}
