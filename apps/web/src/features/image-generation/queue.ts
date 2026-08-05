/**
 * 生图排队与分布式并发控制。
 *
 * 使用方：统一生图管线。进程内队列只保存不可序列化的回调和本进程优先级顺序；
 * 全局及单用户并发槽由必填 Redis 原子租约统一裁决，多副本之间不再各自计数。
 */

import type { QueuePriority as LegacyQueuePriority } from "@repo/shared/config/subscription-plan";
import { logWarn } from "@repo/shared/logger";
import { getRuntimeSettingNumber } from "@repo/shared/system-settings";
import { OperationError } from "@repo/shared/uol";

import {
  acquireImageGenerationAdmission,
  acquireImageGenerationExecution,
  getImageGenerationSlotLeaseTtlMs,
  type RedisImageGenerationAdmissionLease,
  type RedisImageGenerationExecutionLease,
  releaseImageGenerationAdmission,
  releaseImageGenerationExecution,
  renewImageGenerationAdmission,
  renewImageGenerationExecution,
} from "./redis-image-generation-slots";

type QueuePriority = number | LegacyQueuePriority;

type QueueTask<T> = {
  id: number;
  priority: QueuePriority;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  run: () => Promise<T>;
  admissionLease: RedisImageGenerationAdmissionLease;
  admissionLost: boolean;
  admissionReleased: boolean;
  ownsAdmissionLease: boolean;
  admissionRenewTimer?: ReturnType<typeof setInterval>;
  executionRenewTimer?: ReturnType<typeof setInterval>;
  executionLease?: RedisImageGenerationExecutionLease;
  started: boolean;
  timeout?: ReturnType<typeof setTimeout>;
};

const LEGACY_PRIORITY_WEIGHT: Record<LegacyQueuePriority, number> = {
  normal: 0,
  priority: 1,
  highest: 2,
};

let nextTaskId = 1;
let scheduling = false;
let schedulingRequested = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const queue: QueueTask<unknown>[] = [];

/** 从环境变量读取正整数；非法值使用安全默认值。 */
function getPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 读取系统动态配置的全站生图并发上限。 */
async function getGlobalConcurrency(): Promise<number> {
  const value = await getRuntimeSettingNumber(
    "IMAGE_GENERATION_GLOBAL_CONCURRENCY",
    500,
    {
      positive: true,
    }
  );
  return Math.max(1, Math.floor(value));
}

/** 读取请求在本进程队列中的最长等待时间。 */
function getQueueTimeoutMs(): number {
  return getPositiveIntegerEnv(
    "IMAGE_GENERATION_QUEUE_TIMEOUT_MS",
    20 * 60_000
  );
}

/** 读取跨实例槽位重试间隔；短轮询仅在本进程有等待任务时存在。 */
function getQueuePollMs(): number {
  return Math.min(
    5_000,
    Math.max(25, getPositiveIntegerEnv("IMAGE_GENERATION_QUEUE_POLL_MS", 250))
  );
}

/** 以租约 TTL 的三分之一作为续期周期，避免排队或执行跨越租约边界。 */
function getLeaseRenewMs(): number {
  return Math.max(5_000, Math.floor(getImageGenerationSlotLeaseTtlMs() / 3));
}

/** 将秒数格式化为现有对外排队错误所需的稳定单位。 */
function formatDuration(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} second(s)`;
}

/** 生成用户已准入但等待全站执行槽超时的稳定错误。 */
function getQueuedTaskTimeoutError(timeoutMs: number): Error {
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  return new Error(
    `Image generation queue is busy. This queued request waited ${formatDuration(timeoutSeconds)} without a free global slot. Please retry shortly.`
  );
}

/** 释放用户准入租约；失败时依赖 TTL/恢复扫描，但不改写已产生的结果。 */
async function releaseAdmissionSafely(
  lease: RedisImageGenerationAdmissionLease
): Promise<void> {
  try {
    await releaseImageGenerationAdmission(lease);
  } catch (error) {
    logWarn("Redis 生图用户准入槽释放失败，等待租约 TTL 自动回收", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

/** 释放全站执行租约；失败时依赖 TTL/恢复扫描。 */
async function releaseExecutionSafely(
  lease: RedisImageGenerationExecutionLease
): Promise<void> {
  try {
    await releaseImageGenerationExecution(lease);
  } catch (error) {
    logWarn("Redis 生图全站执行槽释放失败，等待租约 TTL 自动回收", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

/** 清除任务的两个租约续期定时器。 */
function clearLeaseRenewTimers(task: QueueTask<unknown>): void {
  if (task.admissionRenewTimer) {
    clearInterval(task.admissionRenewTimer);
    task.admissionRenewTimer = undefined;
  }
  if (task.executionRenewTimer) {
    clearInterval(task.executionRenewTimer);
    task.executionRenewTimer = undefined;
  }
}

/** 在任务等待和执行期间持续续期准入租约，丢失时禁止尚未开始的外呼。 */
function startAdmissionRenewal(task: QueueTask<unknown>): void {
  task.admissionRenewTimer = setInterval(() => {
    void (async () => {
      try {
        const result = await renewImageGenerationAdmission(task.admissionLease);
        if (result.status === "lost") {
          task.admissionLost = true;
          if (!task.started && removeQueuedTask(task)) {
            clearLeaseRenewTimers(task);
            if (task.ownsAdmissionLease) {
              await releaseAdmissionSafely(task.admissionLease);
              task.admissionReleased = true;
            }
            task.reject(
              new Error(
                "Image generation admission lease was lost. Please retry shortly."
              )
            );
            void scheduleQueue();
          }
        }
      } catch (error) {
        task.admissionLost = true;
        if (!task.started && removeQueuedTask(task)) {
          clearLeaseRenewTimers(task);
          if (task.ownsAdmissionLease) {
            await releaseAdmissionSafely(task.admissionLease);
            task.admissionReleased = true;
          }
          task.reject(error);
          void scheduleQueue();
        }
      }
    })();
  }, getLeaseRenewMs());
  task.admissionRenewTimer.unref?.();
}

/** 在执行期间续期全站槽，避免长任务超过租约 TTL 后被其他实例复用。 */
function startExecutionRenewal(task: QueueTask<unknown>): void {
  task.executionRenewTimer = setInterval(() => {
    void (async () => {
      const lease = task.executionLease;
      if (!lease) return;
      try {
        const result = await renewImageGenerationExecution(lease);
        if (result.status === "lost") {
          logWarn("Redis 生图全站执行槽租约丢失，任务将依赖终态结算", {
            taskId: task.id,
          });
        }
      } catch (error) {
        logWarn("Redis 生图全站执行槽续期失败，任务将依赖租约 TTL", {
          taskId: task.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    })();
  }, getLeaseRenewMs());
  task.executionRenewTimer.unref?.();
}

/** 按分组数字 priority、兼容旧字符串优先级和本进程入队顺序稳定排序。 */
function sortQueue(): void {
  queue.sort((left, right) => {
    const priorityDelta = compareQueuePriority(left.priority, right.priority);
    return priorityDelta || left.id - right.id;
  });
}

/** 比较数字分组 priority；旧字符串只在兼容调用方仍存在时使用。 */
function compareQueuePriority(
  left: QueuePriority,
  right: QueuePriority
): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  return LEGACY_PRIORITY_WEIGHT[right] - LEGACY_PRIORITY_WEIGHT[left];
}

/** 从本进程等待队列移除指定任务。 */
function removeQueuedTask(task: QueueTask<unknown>): boolean {
  const index = queue.indexOf(task);
  if (index === -1) return false;
  queue.splice(index, 1);
  return true;
}

/** 清除当前跨实例容量轮询定时器。 */
function clearRetryTimer(): void {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

/**
 * 安排带抖动的下一次 Redis 获槽尝试。
 *
 * 其他应用副本释放槽位时不会触发本进程回调，因此只要仍有等待任务就必须轮询；
 * 抖动避免多个副本在相同毫秒同时争抢刚释放的槽位。
 */
function scheduleRetry(): void {
  if (retryTimer || queue.length === 0) return;
  const pollMs = getQueuePollMs();
  const jitterMs = Math.floor(Math.random() * Math.max(25, pollMs / 5));
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void scheduleQueue();
  }, pollMs + jitterMs);
  retryTimer.unref?.();
}

/** Redis 获取失败时拒绝本进程全部等待任务，禁止悄悄切换成本地槽位。 */
async function rejectQueuedTasks(error: unknown): Promise<void> {
  clearRetryTimer();
  const pending = queue.splice(0, queue.length);
  for (const task of pending) {
    if (task.timeout) clearTimeout(task.timeout);
    clearLeaseRenewTimers(task);
    if (task.ownsAdmissionLease && !task.admissionReleased) {
      await releaseAdmissionSafely(task.admissionLease);
      task.admissionReleased = true;
    }
    task.reject(error);
  }
}

/**
 * 执行已获得 Redis 租约的任务并在结算 Promise 前释放槽位。
 *
 * 上游成功或失败都释放；释放故障只记录安全分类并依赖 TTL 回收，不能把已经完成且
 * 可能已经扣费的生成改写成失败，否则调用方重试可能产生重复副作用。
 */
function startTask<T>(
  task: QueueTask<T>,
  lease: RedisImageGenerationExecutionLease
): void {
  if (task.timeout) clearTimeout(task.timeout);
  task.started = true;
  task.executionLease = lease;
  if (task.admissionLost) {
    clearLeaseRenewTimers(task as QueueTask<unknown>);
    void releaseExecutionSafely(lease);
    if (task.ownsAdmissionLease && !task.admissionReleased) {
      task.admissionReleased = true;
      void releaseAdmissionSafely(task.admissionLease);
    }
    task.reject(
      new Error(
        "Image generation admission lease was lost. Please retry shortly."
      )
    );
    return;
  }
  startExecutionRenewal(task as QueueTask<unknown>);
  void (async () => {
    let outcome:
      | { status: "fulfilled"; value: T }
      | { status: "rejected"; reason: unknown };
    try {
      outcome = { status: "fulfilled", value: await task.run() };
    } catch (error) {
      outcome = { status: "rejected", reason: error };
    }

    clearLeaseRenewTimers(task as QueueTask<unknown>);
    await releaseExecutionSafely(lease);
    if (task.ownsAdmissionLease && !task.admissionReleased) {
      await releaseAdmissionSafely(task.admissionLease);
      task.admissionReleased = true;
    }

    if (outcome.status === "fulfilled") task.resolve(outcome.value);
    else task.reject(outcome.reason);
    void scheduleQueue();
  })();
}

/**
 * 按本地优先级逐项尝试获取 Redis 分布式槽位。
 *
 * 用户准入已在入队前完成；全局容量不足时停止本轮并等待重试。Redis 命令失败会
 * 拒绝全部本地等待请求，确保依赖故障期间不会超卖全站执行并发。
 */
async function scheduleQueue(): Promise<void> {
  if (scheduling) {
    schedulingRequested = true;
    return;
  }
  scheduling = true;
  clearRetryTimer();
  try {
    sortQueue();
    const globalConcurrency = await getGlobalConcurrency();
    for (let index = 0; index < queue.length; index += 1) {
      const task = queue[index];
      if (!task) continue;
      let acquisition: Awaited<
        ReturnType<typeof acquireImageGenerationExecution>
      >;
      try {
        acquisition = await acquireImageGenerationExecution({
          globalConcurrency,
        });
      } catch (error) {
        await rejectQueuedTasks(error);
        return;
      }
      const currentIndex = queue.indexOf(task);
      if (currentIndex === -1) {
        // 排队超时可能发生在 Redis 命令等待期间；迟到的成功租约必须立即归还，
        // 且绝不能执行已经向调用方报超时的任务。
        if (acquisition.status === "acquired") {
          await releaseExecutionSafely(acquisition.lease);
        }
        index -= 1;
        continue;
      }
      if (acquisition.status === "blocked") {
        break;
      }

      queue.splice(currentIndex, 1);
      index = currentIndex - 1;
      startTask(task, acquisition.lease);
    }
  } finally {
    scheduling = false;
    if (queue.length > 0) scheduleRetry();
    if (schedulingRequested) {
      schedulingRequested = false;
      void scheduleQueue();
    }
  }
}

/**
 * 将一次生图工作纳入分组优先级队列和 Redis 两级并发槽。
 *
 * @param options 用户、分组 priority、单用户并发上限与可选等待超时。
 * @param run 只在成功获得全局及用户槽位后执行的生图工作。
 * @returns 原工作结果；排队超时、Redis 故障或工作异常均显式拒绝。
 */
export async function withImageGenerationQueue<T>(
  options: {
    userId: string;
    priority: QueuePriority;
    userConcurrency: number;
    effectiveSource?: "system_default" | "user_override";
    admissionLease?: RedisImageGenerationAdmissionLease;
    releaseAdmissionOnCompletion?: boolean;
    timeoutMs?: number;
  },
  run: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void (async () => {
      let admissionLease = options.admissionLease;
      const ownsAdmissionLease =
        !admissionLease || options.releaseAdmissionOnCompletion !== false;
      if (!admissionLease) {
        const admission = await acquireImageGenerationAdmission({
          userId: options.userId,
          userConcurrency: Math.max(1, Math.floor(options.userConcurrency)),
        });
        if (admission.status === "blocked") {
          throw new OperationError(
            "concurrency_limit_exceeded",
            `用户同时进行的生图任务已达到上限 ${Math.max(1, Math.floor(options.userConcurrency))}`,
            {
              limit: Math.max(1, Math.floor(options.userConcurrency)),
              effectiveSource: options.effectiveSource ?? "system_default",
              scope: "user",
            }
          );
        }
        admissionLease = admission.lease;
      }

      const timeoutMs = options.timeoutMs || getQueueTimeoutMs();
      let task: QueueTask<T>;
      task = {
        id: nextTaskId++,
        priority: options.priority,
        resolve,
        reject,
        run,
        admissionLease,
        admissionLost: false,
        admissionReleased: false,
        ownsAdmissionLease,
        started: false,
        timeout: setTimeout(() => {
          if (removeQueuedTask(task as QueueTask<unknown>)) {
            clearLeaseRenewTimers(task as QueueTask<unknown>);
            void (async () => {
              if (task.ownsAdmissionLease) {
                await releaseAdmissionSafely(task.admissionLease);
                task.admissionReleased = true;
              }
              reject(getQueuedTaskTimeoutError(timeoutMs));
              if (queue.length === 0) clearRetryTimer();
            })();
          }
        }, timeoutMs),
      };

      queue.push(task as QueueTask<unknown>);
      startAdmissionRenewal(task as QueueTask<unknown>);
      void scheduleQueue();
    })().catch(async (error: unknown) => {
      if (error instanceof OperationError) {
        reject(error);
        return;
      }
      reject(error);
    });
  });
}
