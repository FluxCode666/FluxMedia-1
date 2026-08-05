/**
 * 生图排队与分布式并发控制。
 *
 * 使用方：统一生图管线。进程内队列只保存不可序列化的回调和本进程优先级顺序；
 * 全局及单用户并发槽由必填 Redis 原子租约统一裁决，多副本之间不再各自计数。
 */

import type { QueuePriority as LegacyQueuePriority } from "@repo/shared/config/subscription-plan";
import { logWarn } from "@repo/shared/logger";
import { getRuntimeSettingNumber } from "@repo/shared/system-settings";

import {
  acquireImageGenerationSlot,
  type RedisImageGenerationSlotLease,
  releaseImageGenerationSlot,
} from "./redis-image-generation-slots";

type QueueBlockReason = "global" | "user";
type QueuePriority = number | LegacyQueuePriority;

type QueueTask<T> = {
  id: number;
  userId: string;
  priority: QueuePriority;
  userConcurrency: number;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  run: () => Promise<T>;
  lastBlockedReason?: QueueBlockReason;
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

/** 将秒数格式化为现有对外排队错误所需的稳定单位。 */
function formatDuration(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} second(s)`;
}

/** 根据 Redis 最近一次容量拒绝原因生成准确的排队超时错误。 */
function getQueuedTaskTimeoutError(
  task: Pick<QueueTask<unknown>, "lastBlockedReason" | "userConcurrency">,
  timeoutMs: number
): Error {
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  if (task.lastBlockedReason === "user") {
    return new Error(
      `Image generation concurrency limit reached for this plan. Your plan allows ${task.userConcurrency} concurrent image generation task(s); this queued request waited ${formatDuration(timeoutSeconds)} without a free slot.`
    );
  }

  return new Error(
    `Image generation queue is busy. This queued request waited ${formatDuration(timeoutSeconds)} without a free global slot. Please retry shortly.`
  );
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
function rejectQueuedTasks(error: unknown): void {
  clearRetryTimer();
  const pending = queue.splice(0, queue.length);
  for (const task of pending) {
    if (task.timeout) clearTimeout(task.timeout);
    task.reject(error);
  }
}

/** 释放租约但不改写已经发生的生图结果；失败时仅等待 TTL 自动回收。 */
async function releaseSlotLeaseSafely(
  lease: RedisImageGenerationSlotLease
): Promise<void> {
  try {
    await releaseImageGenerationSlot(lease);
  } catch (error) {
    logWarn("Redis 生图并发槽释放失败，等待租约 TTL 自动回收", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
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
  lease: RedisImageGenerationSlotLease
): void {
  if (task.timeout) clearTimeout(task.timeout);
  void (async () => {
    let outcome:
      | { status: "fulfilled"; value: T }
      | { status: "rejected"; reason: unknown };
    try {
      outcome = { status: "fulfilled", value: await task.run() };
    } catch (error) {
      outcome = { status: "rejected", reason: error };
    }

    await releaseSlotLeaseSafely(lease);

    if (outcome.status === "fulfilled") task.resolve(outcome.value);
    else task.reject(outcome.reason);
    void scheduleQueue();
  })();
}

/**
 * 按本地优先级逐项尝试获取 Redis 分布式槽位。
 *
 * 用户容量不足时继续检查其他用户；全局容量不足时停止本轮并等待重试。Redis 命令
 * 失败会拒绝全部本地等待请求，确保依赖故障期间不会超卖并发。
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
      let acquisition: Awaited<ReturnType<typeof acquireImageGenerationSlot>>;
      try {
        acquisition = await acquireImageGenerationSlot({
          userId: task.userId,
          globalConcurrency,
          userConcurrency: task.userConcurrency,
        });
      } catch (error) {
        rejectQueuedTasks(error);
        return;
      }
      const currentIndex = queue.indexOf(task);
      if (currentIndex === -1) {
        // 排队超时可能发生在 Redis 命令等待期间；迟到的成功租约必须立即归还，
        // 且绝不能执行已经向调用方报超时的任务。
        if (acquisition.status === "acquired") {
          await releaseSlotLeaseSafely(acquisition.lease);
        }
        index -= 1;
        continue;
      }
      if (acquisition.status === "blocked") {
        task.lastBlockedReason = acquisition.reason;
        if (acquisition.reason === "global") break;
        index = currentIndex;
        continue;
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
    timeoutMs?: number;
  },
  run: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutMs = options.timeoutMs || getQueueTimeoutMs();
    let task: QueueTask<T>;
    task = {
      id: nextTaskId++,
      userId: options.userId,
      priority: options.priority,
      userConcurrency: Math.max(1, Math.floor(options.userConcurrency)),
      resolve,
      reject,
      run,
      timeout: setTimeout(() => {
        if (removeQueuedTask(task as QueueTask<unknown>)) {
          reject(getQueuedTaskTimeoutError(task, timeoutMs));
          if (queue.length === 0) clearRetryTimer();
        }
      }, timeoutMs),
    };

    queue.push(task as QueueTask<unknown>);
    void scheduleQueue();
  });
}
