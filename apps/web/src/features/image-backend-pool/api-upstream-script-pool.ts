/**
 * API 上游脚本的进程单例 Worker Thread Pool。
 *
 * 职责：提供有界高低优先队列、外呼前未来响应许可、Worker 故障淘汰和
 * ready → draining → closed 生命周期；本模块不解析脚本输出或接触媒体正文。
 */
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  API_UPSTREAM_MAX_SCRIPT_CHARACTERS,
  API_UPSTREAM_MAX_SERIALIZED_BYTES,
  type ApiUpstreamAdapterOperationId,
} from "@repo/shared/image-backend/api-upstream-script-contract";
import { logWarn } from "@repo/shared/logger";

import {
  type ApiUpstreamScriptRuntimeConfig,
  parseApiUpstreamScriptRuntimeConfig,
} from "./api-upstream-script-runtime-config";

/** Pool 对外暴露的稳定生命周期。 */
export type ApiUpstreamScriptPoolState = "ready" | "draining" | "closed";

/** 作业阶段只用于调度与脱敏诊断，不传递供应商数据。 */
export type ApiUpstreamScriptJobPriority =
  | "request"
  | "response"
  | "validation"
  | "admin";

/** 发送给 Worker 的结构化克隆安全作业。 */
export interface ApiUpstreamScriptPoolJob {
  readonly kind: "validate" | "execute";
  readonly script: string;
  readonly inputJson?: string;
  readonly contextJson?: string;
  readonly priority: ApiUpstreamScriptJobPriority;
  readonly operation: ApiUpstreamAdapterOperationId;
  readonly stage: "request" | "response";
}

/** Worker Pool 的脱敏进程诊断，不包含脚本、Body、Header 或任务 ID。 */
export interface ApiUpstreamScriptPoolDiagnostics {
  readonly state: ApiUpstreamScriptPoolState;
  readonly configuredWorkers: number;
  readonly readyWorkers: number;
  readonly busyWorkers: number;
  readonly queuedRequests: number;
  readonly queuedResponses: number;
  readonly queuedBytes: number;
  readonly activeResponsePermits: number;
  readonly responsePermitCapacity: number;
  readonly saturationCount: number;
  readonly replacementCount: number;
}

type PoolErrorCode =
  | "invalid_script"
  | "execution_failed"
  | "invalid_output"
  | "runtime_saturated"
  | "runtime_closed"
  | "runtime_timeout"
  | "worker_failed";

/** 不暴露 Worker、源码或上游正文的 Pool 稳定错误。 */
export class ApiUpstreamScriptPoolError extends Error {
  readonly code: PoolErrorCode;
  readonly retryAfterSeconds?: number;

  /**
   * @param code - 供上层类型化映射的稳定错误码。
   * @param retryAfterSeconds - 平台繁忙时建议调用方等待的秒数。
   */
  constructor(code: PoolErrorCode, retryAfterSeconds?: number) {
    super(
      code === "runtime_saturated"
        ? "API 上游脚本运行时繁忙"
        : code === "runtime_closed"
          ? "API 上游脚本运行时已关闭"
          : "API 上游脚本执行失败"
    );
    this.name = "ApiUpstreamScriptPoolError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface WorkerReadyMessage {
  readonly type: "ready";
}

interface WorkerResultMessage {
  readonly type: "result";
  readonly id: string;
  readonly ok: boolean;
  readonly outputJson?: string;
  readonly code?: string;
  readonly replaceWorker?: boolean;
}

interface QueuedJob {
  readonly id: string;
  readonly payload: ApiUpstreamScriptPoolJob;
  readonly byteLength: number;
  readonly asyncResource: AsyncResource;
  readonly responsePermitId?: string;
  readonly resolve: (value: string | undefined) => void;
  readonly reject: (reason: ApiUpstreamScriptPoolError) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface WorkerSlot {
  readonly id: number;
  readonly worker: Worker;
  ready: boolean;
  retiring: boolean;
  currentJob?: QueuedJob;
  wallTimer?: ReturnType<typeof setTimeout>;
}

interface PermitWaiter {
  readonly resolve: (permit: ApiUpstreamResponsePermit) => void;
  readonly reject: (reason: ApiUpstreamScriptPoolError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type PoolGlobal = typeof globalThis & {
  __fluxmediaApiUpstreamScriptPool?: ApiUpstreamScriptPool;
  __fluxmediaApiUpstreamScriptPoolPromise?: Promise<ApiUpstreamScriptPool>;
};

const SCRIPT_EXECUTION_TIMEOUT_MS = 50;
const WORKER_WALL_TIMEOUT_MS = 500;
const WORKER_START_TIMEOUT_MS = 10_000;
const REQUEST_QUEUE_WAIT_MS = 2_000;
const RESPONSE_QUEUE_WAIT_MS = 5_000;
const QUEUED_REQUESTS_PER_WORKER = 64;
const RESPONSE_PERMITS_PER_WORKER = 16;
const QUEUED_BYTES_PER_WORKER = 32 * 1024 * 1024;
const SCRIPT_SOURCE_OVERHEAD_PER_PERMIT = API_UPSTREAM_MAX_SCRIPT_CHARACTERS;
const SHUTDOWN_GRACE_MS = 5_000;
const poolGlobal = globalThis as PoolGlobal;

/**
 * 解析被 file tracing 显式带入产物的 Worker 源入口。
 *
 * Turbopack 会把字面量 `new Worker(new URL(...))` 误识别为浏览器 Worker 并在
 * Server Component 编译中失败，因此路径保持由 Node 的 URL 构造器解析；入口和
 * QuickJS 资产仍由 next.config 的窄范围 trace 显式纳入 standalone。
 */
function getWorkerEntryUrl(): URL {
  const workingDirectory = process.cwd();
  const webRoot =
    basename(workingDirectory) === "web"
      ? workingDirectory
      : resolve(workingDirectory, "apps/web");
  return pathToFileURL(
    resolve(
      webRoot,
      "src/features/image-backend-pool/api-upstream-script-worker.mjs"
    )
  );
}

/** 判断未知 Worker 消息是否是就绪通知。 */
function isWorkerReadyMessage(value: unknown): value is WorkerReadyMessage {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as Record<string, unknown>).type === "ready"
  );
}

/** 判断未知 Worker 消息是否是最小结果协议。 */
function isWorkerResultMessage(value: unknown): value is WorkerResultMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "result" &&
    typeof candidate.id === "string" &&
    typeof candidate.ok === "boolean"
  );
}

/** 将 Worker 内部失败码收敛为宿主稳定类型。 */
function normalizeWorkerErrorCode(code: string | undefined): PoolErrorCode {
  if (
    code === "invalid_script" ||
    code === "execution_failed" ||
    code === "invalid_output"
  ) {
    return code;
  }
  return "worker_failed";
}

/**
 * 表示一次外呼未来响应的 Pool 级许可。
 *
 * 许可不绑定 Worker；调用方必须在未外呼或响应脚本结算后释放，重复释放无副作用。
 */
export class ApiUpstreamResponsePermit {
  readonly id: string;
  private released = false;
  private readonly pool: ApiUpstreamScriptPool;

  /** 仅由 Pool 签发许可。 */
  constructor(pool: ApiUpstreamScriptPool, id: string) {
    this.pool = pool;
    this.id = id;
  }

  /** 当前许可是否仍能接收一个真实响应作业。 */
  get active(): boolean {
    return !this.released;
  }

  /**
   * 以高优先级运行真实响应脚本，并在结算后恰好释放一次许可。
   *
   * @param job - 不含 priority 的响应脚本作业。
   * @returns Worker 返回的 JSON 字符串。
   */
  async run(
    job: Omit<ApiUpstreamScriptPoolJob, "priority" | "stage">
  ): Promise<string | undefined> {
    if (this.released) {
      throw new ApiUpstreamScriptPoolError("runtime_closed");
    }
    try {
      return await this.pool.runWithResponsePermit(
        { ...job, priority: "response", stage: "response" },
        this.id
      );
    } finally {
      this.release();
    }
  }

  /** 未外呼或不再需要处理响应时幂等释放许可。 */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.pool.releaseResponsePermit(this.id);
  }
}

/** 有界、可关闭的进程内 Worker Pool。 */
export class ApiUpstreamScriptPool {
  private stateValue: ApiUpstreamScriptPoolState = "closed";
  private readonly slots: WorkerSlot[] = [];
  private readonly requestQueue: QueuedJob[] = [];
  private readonly responseQueue: QueuedJob[] = [];
  private readonly responsePermits = new Set<string>();
  private readonly permitWaiters: PermitWaiter[] = [];
  private queuedBytes = 0;
  private nextWorkerId = 1;
  private replacementFailures = 0;
  private saturationCount = 0;
  private replacementCount = 0;
  private shutdownPromise?: Promise<void>;

  /** @param config - 已在启动阶段严格验证的不可变部署配置。 */
  constructor(readonly config: Readonly<ApiUpstreamScriptRuntimeConfig>) {}

  /** 当前生命周期。 */
  get state(): ApiUpstreamScriptPoolState {
    return this.stateValue;
  }

  /** 幂等建立全部 Worker；任一初始 Worker 失败会使启动失败。 */
  async start(): Promise<void> {
    if (this.stateValue === "ready") return;
    if (this.stateValue === "draining") {
      throw new ApiUpstreamScriptPoolError("runtime_closed");
    }
    this.stateValue = "ready";
    try {
      await Promise.all(
        Array.from({ length: this.config.workerCount }, () =>
          this.spawnWorker(true)
        )
      );
    } catch (error) {
      await this.shutdown(0);
      throw error;
    }
  }

  /**
   * 运行普通请求、保存校验或管理测试作业。
   *
   * @param payload - 只含字符串协议和脱敏维度的作业。
   * @returns Worker 产生的 JSON 字符串；语法验证无输出。
   */
  run(payload: ApiUpstreamScriptPoolJob): Promise<string | undefined> {
    if (payload.priority === "response") {
      return Promise.reject(new ApiUpstreamScriptPoolError("runtime_closed"));
    }
    return this.enqueue(payload);
  }

  /**
   * 外呼前预留一个未来响应许可，最多等待两秒。
   *
   * @returns 不绑定 Worker 的一次性许可。
   * @throws ApiUpstreamScriptPoolError 饱和时返回可重试平台错误。
   */
  reserveResponsePermit(): Promise<ApiUpstreamResponsePermit> {
    if (this.stateValue !== "ready") {
      return Promise.reject(new ApiUpstreamScriptPoolError("runtime_closed"));
    }
    if (this.responsePermits.size < this.responsePermitCapacity()) {
      return Promise.resolve(this.issueResponsePermit());
    }
    if (this.permitWaiters.length >= this.regularQueueCapacity()) {
      this.logSaturation("response_permit");
      return Promise.reject(
        new ApiUpstreamScriptPoolError("runtime_saturated", 1)
      );
    }
    return new Promise((resolve, reject) => {
      const waiter: PermitWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.permitWaiters.indexOf(waiter);
          if (index >= 0) this.permitWaiters.splice(index, 1);
          this.logSaturation("response_permit");
          reject(new ApiUpstreamScriptPoolError("runtime_saturated", 1));
        }, REQUEST_QUEUE_WAIT_MS),
      };
      this.permitWaiters.push(waiter);
    });
  }

  /** 生成不含敏感正文的当前进程诊断。 */
  diagnostics(): ApiUpstreamScriptPoolDiagnostics {
    return {
      state: this.stateValue,
      configuredWorkers: this.config.workerCount,
      readyWorkers: this.slots.filter((slot) => slot.ready && !slot.retiring)
        .length,
      busyWorkers: this.slots.filter((slot) => slot.currentJob).length,
      queuedRequests: this.requestQueue.length,
      queuedResponses: this.responseQueue.length,
      queuedBytes: this.queuedBytes,
      activeResponsePermits: this.responsePermits.size,
      responsePermitCapacity: this.responsePermitCapacity(),
      saturationCount: this.saturationCount,
      replacementCount: this.replacementCount,
    };
  }

  /**
   * 停止低优先级准入，给已预留响应有限时间结算，再终止全部 Worker。
   *
   * @param graceMs - 等待活跃和响应作业的墙钟上限。
   */
  shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(graceMs);
    return this.shutdownPromise;
  }

  /** 仅供一次性响应许可调用，不允许其他调用方伪造高优先级。 */
  runWithResponsePermit(
    payload: ApiUpstreamScriptPoolJob,
    permitId: string
  ): Promise<string | undefined> {
    if (!this.responsePermits.has(permitId)) {
      return Promise.reject(new ApiUpstreamScriptPoolError("runtime_closed"));
    }
    return this.enqueue(payload, permitId);
  }

  /** 由许可对象幂等回收容量，并按先到先得唤醒等待者。 */
  releaseResponsePermit(permitId: string): void {
    if (!this.responsePermits.delete(permitId)) return;
    this.drainPermitWaiters();
  }

  /** 返回普通排队位总数。 */
  private regularQueueCapacity(): number {
    return this.config.workerCount * QUEUED_REQUESTS_PER_WORKER;
  }

  /** 返回 Pool 级未来响应许可总数。 */
  private responsePermitCapacity(): number {
    return this.config.workerCount * RESPONSE_PERMITS_PER_WORKER;
  }

  /** 返回排队数据预算；额外源码开销不挤占 32 MiB 普通 JSON 预算。 */
  private queuedByteCapacity(): number {
    return (
      this.config.workerCount * QUEUED_BYTES_PER_WORKER +
      this.responsePermitCapacity() * SCRIPT_SOURCE_OVERHEAD_PER_PERMIT
    );
  }

  /** 签发一个新的不可预测许可。 */
  private issueResponsePermit(): ApiUpstreamResponsePermit {
    const id = randomUUID();
    this.responsePermits.add(id);
    return new ApiUpstreamResponsePermit(this, id);
  }

  /** 在释放许可后唤醒仍处于 ready 状态的首个等待者。 */
  private drainPermitWaiters(): void {
    while (
      this.stateValue === "ready" &&
      this.responsePermits.size < this.responsePermitCapacity()
    ) {
      const waiter = this.permitWaiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiter.resolve(this.issueResponsePermit());
    }
  }

  /** 创建可跟踪的队列作业并按优先级准入。 */
  private enqueue(
    payload: ApiUpstreamScriptPoolJob,
    responsePermitId?: string
  ): Promise<string | undefined> {
    if (
      this.stateValue === "closed" ||
      (this.stateValue === "draining" && payload.priority !== "response")
    ) {
      return Promise.reject(new ApiUpstreamScriptPoolError("runtime_closed"));
    }
    const byteLength =
      Buffer.byteLength(payload.script) +
      Buffer.byteLength(payload.inputJson ?? "") +
      Buffer.byteLength(payload.contextJson ?? "");

    return new Promise((resolve, reject) => {
      const job: QueuedJob = {
        id: randomUUID(),
        payload,
        byteLength,
        asyncResource: new AsyncResource("ApiUpstreamScriptJob"),
        responsePermitId,
        resolve,
        reject,
        settled: false,
      };

      if (payload.priority === "response") {
        this.evictRequestsUntilFits(byteLength);
        if (this.queuedBytes + byteLength > this.queuedByteCapacity()) {
          this.settleJob(
            job,
            undefined,
            new ApiUpstreamScriptPoolError("runtime_saturated", 1)
          );
          this.logSaturation("response_queue_bytes");
          return;
        }
        this.responseQueue.push(job);
        this.queuedBytes += byteLength;
        this.armQueueTimer(job, RESPONSE_QUEUE_WAIT_MS);
      } else {
        if (
          this.requestQueue.length >= this.regularQueueCapacity() ||
          this.queuedBytes + byteLength > this.queuedByteCapacity()
        ) {
          this.settleJob(
            job,
            undefined,
            new ApiUpstreamScriptPoolError("runtime_saturated", 1)
          );
          this.logSaturation("request_queue");
          return;
        }
        this.requestQueue.push(job);
        this.queuedBytes += byteLength;
        this.armQueueTimer(job, REQUEST_QUEUE_WAIT_MS);
      }
      this.dispatch();
    });
  }

  /** 高优先级响应到达时先驱逐尚未执行、尚未外呼的低优先级作业。 */
  private evictRequestsUntilFits(incomingBytes: number): void {
    while (
      this.requestQueue.length > 0 &&
      this.queuedBytes + incomingBytes > this.queuedByteCapacity()
    ) {
      const evicted = this.requestQueue.pop();
      if (!evicted) break;
      this.removeQueuedAccounting(evicted);
      this.settleJob(
        evicted,
        undefined,
        new ApiUpstreamScriptPoolError("runtime_saturated", 1)
      );
      this.logSaturation("request_evicted_for_response");
    }
  }

  /** 为排队作业设置最大等待时间，超时只结算一次。 */
  private armQueueTimer(job: QueuedJob, timeoutMs: number): void {
    job.queueTimer = setTimeout(() => {
      const queue =
        job.payload.priority === "response"
          ? this.responseQueue
          : this.requestQueue;
      const index = queue.indexOf(job);
      if (index < 0) return;
      queue.splice(index, 1);
      this.removeQueuedAccounting(job);
      this.settleJob(
        job,
        undefined,
        new ApiUpstreamScriptPoolError("runtime_saturated", 1)
      );
      this.logSaturation(
        job.payload.priority === "response"
          ? "response_queue_timeout"
          : "request_queue_timeout"
      );
    }, timeoutMs);
  }

  /** 从队列移出作业时统一更新字节和计时器。 */
  private removeQueuedAccounting(job: QueuedJob): void {
    this.queuedBytes = Math.max(0, this.queuedBytes - job.byteLength);
    if (job.queueTimer) clearTimeout(job.queueTimer);
    job.queueTimer = undefined;
  }

  /** 优先把真实响应分配给空闲 Worker，再处理普通请求与管理作业。 */
  private dispatch(): void {
    if (this.stateValue === "closed") return;
    for (const slot of this.slots) {
      if (!slot.ready || slot.retiring || slot.currentJob) continue;
      const job = this.responseQueue.shift() ?? this.requestQueue.shift();
      if (!job) return;
      this.removeQueuedAccounting(job);
      slot.currentJob = job;
      slot.wallTimer = setTimeout(() => {
        void this.retireWorker(
          slot,
          new ApiUpstreamScriptPoolError("runtime_timeout")
        );
      }, WORKER_WALL_TIMEOUT_MS);
      slot.worker.postMessage({
        type: "job",
        id: job.id,
        kind: job.payload.kind,
        script: job.payload.script,
        inputJson: job.payload.inputJson,
        contextJson: job.payload.contextJson,
        timeoutMs: SCRIPT_EXECUTION_TIMEOUT_MS,
        memoryLimitBytes: this.config.memoryLimitBytes,
        stackLimitBytes: this.config.stackLimitBytes,
        maxScriptCharacters: API_UPSTREAM_MAX_SCRIPT_CHARACTERS,
        maxSerializedBytes: API_UPSTREAM_MAX_SERIALIZED_BYTES,
      });
    }
  }

  /** 创建 Worker 并等待 QuickJS 模块就绪。 */
  private spawnWorker(initial: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(getWorkerEntryUrl(), {
        name: `api-upstream-script-${this.nextWorkerId}`,
      });
      const slot: WorkerSlot = {
        id: this.nextWorkerId,
        worker,
        ready: false,
        retiring: false,
      };
      this.nextWorkerId += 1;
      this.slots.push(slot);
      const startTimer = setTimeout(() => {
        reject(new ApiUpstreamScriptPoolError("worker_failed"));
        void this.retireWorker(slot);
      }, WORKER_START_TIMEOUT_MS);

      worker.on("message", (message: unknown) => {
        if (isWorkerReadyMessage(message) && !slot.ready) {
          clearTimeout(startTimer);
          slot.ready = true;
          this.replacementFailures = 0;
          resolve();
          this.dispatch();
          return;
        }
        this.handleWorkerMessage(slot, message);
      });
      worker.on("messageerror", () => {
        clearTimeout(startTimer);
        if (!slot.ready)
          reject(new ApiUpstreamScriptPoolError("worker_failed"));
        void this.retireWorker(
          slot,
          new ApiUpstreamScriptPoolError("worker_failed")
        );
      });
      worker.on("error", () => {
        clearTimeout(startTimer);
        if (!slot.ready)
          reject(new ApiUpstreamScriptPoolError("worker_failed"));
        void this.retireWorker(
          slot,
          new ApiUpstreamScriptPoolError("worker_failed")
        );
      });
      worker.on("exit", (exitCode) => {
        clearTimeout(startTimer);
        if (slot.retiring) return;
        if (!slot.ready || exitCode !== 0) {
          if (!slot.ready)
            reject(new ApiUpstreamScriptPoolError("worker_failed"));
        }
        // Worker 入口不应自然退出；即使退出码为 0，也不能保留一个永远不会接单的槽位。
        void this.retireWorker(
          slot,
          new ApiUpstreamScriptPoolError("worker_failed")
        );
      });

      if (!initial && this.stateValue !== "ready") {
        clearTimeout(startTimer);
        void this.retireWorker(slot);
        reject(new ApiUpstreamScriptPoolError("runtime_closed"));
      }
    });
  }

  /** 校验 Worker 结果 ID，并结算当前作业或淘汰协议异常 Worker。 */
  private handleWorkerMessage(slot: WorkerSlot, message: unknown): void {
    if (!isWorkerResultMessage(message)) {
      if (slot.ready) {
        void this.retireWorker(
          slot,
          new ApiUpstreamScriptPoolError("worker_failed")
        );
      }
      return;
    }
    const job = slot.currentJob;
    if (!job || message.id !== job.id) {
      void this.retireWorker(
        slot,
        new ApiUpstreamScriptPoolError("worker_failed")
      );
      return;
    }
    if (slot.wallTimer) clearTimeout(slot.wallTimer);
    slot.wallTimer = undefined;
    slot.currentJob = undefined;

    if (message.ok) {
      this.settleJob(job, message.outputJson);
    } else {
      this.settleJob(
        job,
        undefined,
        new ApiUpstreamScriptPoolError(normalizeWorkerErrorCode(message.code))
      );
    }
    if (message.replaceWorker) {
      void this.retireWorker(slot);
    } else {
      this.dispatch();
    }
  }

  /**
   * 淘汰 Worker：先从调度中移除，等待 terminate 完成，再按有界退避补建。
   */
  private async retireWorker(
    slot: WorkerSlot,
    currentError = new ApiUpstreamScriptPoolError("worker_failed")
  ): Promise<void> {
    if (slot.retiring) return;
    slot.retiring = true;
    slot.ready = false;
    if (slot.wallTimer) clearTimeout(slot.wallTimer);
    slot.wallTimer = undefined;
    if (slot.currentJob) {
      const job = slot.currentJob;
      slot.currentJob = undefined;
      this.settleJob(job, undefined, currentError);
    }
    try {
      await slot.worker.terminate();
    } catch {
      // terminate 失败仍继续移除引用，避免已损坏 Worker 再次接单。
    }
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);

    if (this.stateValue === "ready") {
      this.replacementCount += 1;
      const backoffMs = Math.min(1_000, 25 * 2 ** this.replacementFailures);
      this.replacementFailures = Math.min(this.replacementFailures + 1, 6);
      setTimeout(() => {
        if (this.stateValue !== "ready") return;
        void this.spawnWorker(false).catch(() => {
          if (this.stateValue === "ready" && this.slots.length === 0) {
            this.logSaturation("worker_replacement_failed");
          }
        });
      }, backoffMs);
    }
  }

  /** 使用 AsyncResource 在原调用上下文中且仅一次完成 Promise。 */
  private settleJob(
    job: QueuedJob,
    output?: string,
    error?: ApiUpstreamScriptPoolError
  ): void {
    if (job.settled) return;
    job.settled = true;
    if (job.queueTimer) clearTimeout(job.queueTimer);
    job.queueTimer = undefined;
    job.asyncResource.runInAsyncScope(() => {
      if (error) job.reject(error);
      else job.resolve(output);
    });
    job.asyncResource.emitDestroy();
  }

  /** 输出厂商无关、无正文的统一饱和事件。 */
  private logSaturation(reason: string): void {
    this.saturationCount += 1;
    logWarn("api_upstream_script_runtime_saturated", {
      event: "api_upstream_script_runtime_saturated",
      reason,
      state: this.stateValue,
      queuedRequests: this.requestQueue.length,
      queuedResponses: this.responseQueue.length,
      activeResponsePermits: this.responsePermits.size,
    });
  }

  /** 执行生命周期关闭的内部实现。 */
  private async performShutdown(graceMs: number): Promise<void> {
    if (this.stateValue === "closed" && this.slots.length === 0) return;
    this.stateValue = "draining";
    for (const waiter of this.permitWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new ApiUpstreamScriptPoolError("runtime_closed"));
    }
    for (const job of this.requestQueue.splice(0)) {
      this.removeQueuedAccounting(job);
      this.settleJob(
        job,
        undefined,
        new ApiUpstreamScriptPoolError("runtime_closed")
      );
    }

    const deadline = Date.now() + Math.max(0, graceMs);
    while (
      Date.now() < deadline &&
      (this.responseQueue.length > 0 ||
        this.slots.some((slot) => slot.currentJob))
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    this.stateValue = "closed";
    for (const job of this.responseQueue.splice(0)) {
      this.removeQueuedAccounting(job);
      this.settleJob(
        job,
        undefined,
        new ApiUpstreamScriptPoolError("runtime_closed")
      );
    }
    for (const permitId of [...this.responsePermits]) {
      this.releaseResponsePermit(permitId);
    }
    await Promise.all([...this.slots].map((slot) => this.retireWorker(slot)));
  }
}

/**
 * 并发安全且幂等地初始化当前进程唯一的 Worker Pool。
 *
 * @returns 已进入 ready 的共享 Pool。
 */
export function ensureApiUpstreamScriptPool(): Promise<ApiUpstreamScriptPool> {
  if (poolGlobal.__fluxmediaApiUpstreamScriptPool?.state === "ready") {
    return Promise.resolve(poolGlobal.__fluxmediaApiUpstreamScriptPool);
  }
  const existing = poolGlobal.__fluxmediaApiUpstreamScriptPoolPromise;
  if (existing) return existing;

  const initialization = (async () => {
    const pool = new ApiUpstreamScriptPool(
      parseApiUpstreamScriptRuntimeConfig()
    );
    await pool.start();
    poolGlobal.__fluxmediaApiUpstreamScriptPool = pool;
    return pool;
  })();
  poolGlobal.__fluxmediaApiUpstreamScriptPoolPromise = initialization;
  void initialization.catch(() => {
    if (poolGlobal.__fluxmediaApiUpstreamScriptPoolPromise === initialization) {
      poolGlobal.__fluxmediaApiUpstreamScriptPoolPromise = undefined;
    }
  });
  return initialization;
}

/** 关闭当前进程的共享 Pool；未启动时无副作用。 */
export async function shutdownApiUpstreamScriptPool(): Promise<void> {
  const pool = poolGlobal.__fluxmediaApiUpstreamScriptPool;
  if (pool) await pool.shutdown();
}

/** 返回共享 Pool 的脱敏诊断；未启动时按严格 env 返回 closed 快照。 */
export function getApiUpstreamScriptPoolDiagnostics(): ApiUpstreamScriptPoolDiagnostics {
  const pool = poolGlobal.__fluxmediaApiUpstreamScriptPool;
  if (pool) return pool.diagnostics();
  const config = parseApiUpstreamScriptRuntimeConfig();
  return {
    state: "closed",
    configuredWorkers: config.workerCount,
    readyWorkers: 0,
    busyWorkers: 0,
    queuedRequests: 0,
    queuedResponses: 0,
    queuedBytes: 0,
    activeResponsePermits: 0,
    responsePermitCapacity: config.workerCount * RESPONSE_PERMITS_PER_WORKER,
    saturationCount: 0,
    replacementCount: 0,
  };
}
