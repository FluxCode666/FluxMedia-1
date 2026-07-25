/**
 * 内置任务运行时调度器。
 *
 * instrumentation 在 Node.js 进程启动时注册本模块。调度器以短周期读取缓存后的
 * system-settings，负责动态启停任务并在间隔变更后重新计算下次执行时间；数据库
 * advisory lock 与任务状态行继续负责多实例去重和可追溯性。
 */

import { db, systemSetting } from "@repo/database";
import {
  getRuntimeSettingBoolean,
  getRuntimeSettingNumber,
} from "@repo/shared/system-settings";
import { eq, sql } from "drizzle-orm";

import { runCreditsExpireJob, runImageMaintenanceJob } from "./scheduled-jobs";

type InternalJob = {
  name: string;
  lockKey: number;
  intervalSettingKey:
    | "INTERNAL_JOB_IMAGES_MAINTENANCE_INTERVAL_MINUTES"
    | "INTERNAL_JOB_CREDITS_EXPIRE_INTERVAL_MINUTES";
  defaultIntervalMinutes: number;
  initialDelayMs: number;
  run: () => Promise<unknown>;
};

type SchedulerState = {
  started: boolean;
  enabled: boolean;
  generation: number;
  tickRunning: boolean;
  timer?: ReturnType<typeof setTimeout>;
  jobs: Map<string, ScheduledJobState>;
};

type ScheduledJobState = {
  running: boolean;
  awaitingInitialRun: boolean;
  intervalMs: number;
  scheduleAnchorMs: number;
  nextRunAtMs?: number;
};

type SchedulerRuntimeConfig = {
  enabled: boolean;
  intervals: Map<string, number>;
};

type SchedulerGlobal = typeof globalThis & {
  __gpt2imageInternalJobScheduler?: SchedulerState;
};

const LOCK_NAMESPACE = 20_260_527;
const MINUTE_MS = 60 * 1000;
const CONFIG_REFRESH_MS = 5_000;
const CONFIG_READ_TIMEOUT_MS = 5_000;
const schedulerGlobal = globalThis as SchedulerGlobal;
let lastRuntimeConfig: SchedulerRuntimeConfig | undefined;

const jobs: InternalJob[] = [
  {
    name: "images-maintenance",
    lockKey: 1,
    intervalSettingKey: "INTERNAL_JOB_IMAGES_MAINTENANCE_INTERVAL_MINUTES",
    defaultIntervalMinutes: 5,
    initialDelayMs: 30_000,
    run: runImageMaintenanceJob,
  },
  {
    name: "credits-expire",
    lockKey: 2,
    intervalSettingKey: "INTERNAL_JOB_CREDITS_EXPIRE_INTERVAL_MINUTES",
    defaultIntervalMinutes: 24 * 60,
    initialDelayMs: 60_000,
    run: runCreditsExpireJob,
  },
];

/**
 * 获取跨模块热重载共享的调度状态。
 *
 * @returns 当前进程唯一的调度状态
 */
function getSchedulerState(): SchedulerState {
  const current = schedulerGlobal.__gpt2imageInternalJobScheduler;
  if (!current || !(current.jobs instanceof Map)) {
    schedulerGlobal.__gpt2imageInternalJobScheduler = {
      started: false,
      enabled: false,
      generation: 0,
      tickRunning: false,
      jobs: new Map(),
    };
  }
  return schedulerGlobal.__gpt2imageInternalJobScheduler as SchedulerState;
}

/**
 * 从 Drizzle execute 的多种结果形态读取首行。
 *
 * @param result - 数据库驱动返回值
 * @returns 首行记录，不存在时为 undefined
 */
function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) {
    return result[0] as Record<string, unknown> | undefined;
  }
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows)
    ? (rows[0] as Record<string, unknown> | undefined)
    : undefined;
}

/**
 * 读取 SQL 布尔字段，非严格 true 均视为 false。
 *
 * @param result - 数据库驱动返回值
 * @param key - 字段名
 * @returns 字段是否为 true
 */
function readBooleanResult(result: unknown, key: string) {
  return firstRow(result)?.[key] === true;
}

/**
 * 生成任务持久状态键。
 *
 * @param job - 任务定义
 * @returns systemSetting 内部键
 */
function getJobStateKey(job: InternalJob) {
  return `__internal_job_scheduler:${job.name}`;
}

/**
 * 从持久状态解析上次开始时间。
 *
 * @param value - systemSetting JSON 值
 * @returns 有效时间戳，格式错误时为 undefined
 */
function readLastStartedAt(value: unknown) {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).lastStartedAt
      : undefined;
  if (typeof candidate !== "string") return undefined;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * 在事务级 advisory lock 下执行任务并记录状态。
 *
 * @param job - 任务定义
 * @param intervalMs - 当前动态间隔，用于跨实例频率校验
 * @param run - 实际任务函数
 * @returns 锁、跳过状态及可选任务结果
 * @throws 任务失败时记录 error 状态后原样抛出
 */
async function withJobLock<T>(
  job: InternalJob,
  intervalMs: number,
  run: () => Promise<T>
) {
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, ${job.lockKey}) as locked`
    );
    if (!readBooleanResult(lockResult, "locked")) {
      return { locked: false as const };
    }

    const stateKey = getJobStateKey(job);
    const now = new Date();
    const [state] = await tx
      .select({ value: systemSetting.value })
      .from(systemSetting)
      .where(eq(systemSetting.key, stateKey))
      .limit(1);
    const lastStartedAt = readLastStartedAt(state?.value);
    if (
      lastStartedAt !== undefined &&
      now.getTime() - lastStartedAt < intervalMs
    ) {
      return {
        locked: true as const,
        skipped: true as const,
        reason: "interval_not_reached",
      };
    }

    await tx
      .insert(systemSetting)
      .values({
        key: stateKey,
        value: {
          job: job.name,
          status: "running",
          lastStartedAt: now.toISOString(),
        },
        isSecret: false,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: {
          value: {
            job: job.name,
            status: "running",
            lastStartedAt: now.toISOString(),
          },
          isSecret: false,
          updatedAt: now,
        },
      });

    try {
      const result = await run();
      const finishedAt = new Date();
      await tx
        .insert(systemSetting)
        .values({
          key: stateKey,
          value: {
            job: job.name,
            status: "success",
            lastStartedAt: now.toISOString(),
            lastFinishedAt: finishedAt.toISOString(),
          },
          isSecret: false,
          updatedAt: finishedAt,
        })
        .onConflictDoUpdate({
          target: systemSetting.key,
          set: {
            value: {
              job: job.name,
              status: "success",
              lastStartedAt: now.toISOString(),
              lastFinishedAt: finishedAt.toISOString(),
            },
            isSecret: false,
            updatedAt: finishedAt,
          },
        });

      return {
        locked: true as const,
        skipped: false as const,
        result,
      };
    } catch (error) {
      const finishedAt = new Date();
      await tx
        .insert(systemSetting)
        .values({
          key: stateKey,
          value: {
            job: job.name,
            status: "error",
            lastStartedAt: now.toISOString(),
            lastFinishedAt: finishedAt.toISOString(),
            error: error instanceof Error ? error.message : "Unknown error",
          },
          isSecret: false,
          updatedAt: finishedAt,
        })
        .onConflictDoUpdate({
          target: systemSetting.key,
          set: {
            value: {
              job: job.name,
              status: "error",
              lastStartedAt: now.toISOString(),
              lastFinishedAt: finishedAt.toISOString(),
              error: error instanceof Error ? error.message : "Unknown error",
            },
            isSecret: false,
            updatedAt: finishedAt,
          },
        });
      throw error;
    }
  });
}

/**
 * 执行一次任务并输出耗时；锁竞争、间隔未到和异常均不影响调度循环。
 *
 * @param job - 任务定义
 * @param intervalMs - 本次执行采用的动态间隔
 * @returns 无返回值
 */
async function runJob(job: InternalJob, intervalMs: number) {
  const startedAt = Date.now();
  try {
    const result = await withJobLock(job, intervalMs, job.run);
    if (!result.locked) return;
    if (result.skipped) return;
    console.info(
      `[internal-jobs] ${job.name} completed in ${Date.now() - startedAt}ms`
    );
  } catch (error) {
    console.warn(`[internal-jobs] ${job.name} failed`, error);
  }
}

/**
 * 给配置读取设置等待上限，避免缓存或数据库故障冻结整个调度循环。
 *
 * @param promise - 配置读取任务
 * @param timeoutMs - 最大等待毫秒数
 * @returns 原任务结果
 * @throws 超时错误，由上层保留最后一次有效配置
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`调度配置读取超过 ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 一次性读取调度开关和全部任务间隔。
 *
 * @returns 当前运行时配置；失败时返回最后有效配置，首次失败则安全禁用任务
 */
async function getSchedulerRuntimeConfig(): Promise<SchedulerRuntimeConfig> {
  const readConfig = async (): Promise<SchedulerRuntimeConfig> => {
    const [enabled, intervalMinutes] = await Promise.all([
      getRuntimeSettingBoolean("INTERNAL_JOB_SCHEDULER_ENABLED", true),
      Promise.all(
        jobs.map((job) =>
          getRuntimeSettingNumber(
            job.intervalSettingKey,
            job.defaultIntervalMinutes,
            { positive: true }
          )
        )
      ),
    ]);
    const intervals = new Map<string, number>();
    for (const [index, job] of jobs.entries()) {
      const minutes = intervalMinutes[index];
      intervals.set(
        job.name,
        Math.max(1, Math.trunc(minutes ?? job.defaultIntervalMinutes)) *
          MINUTE_MS
      );
    }
    return { enabled: Boolean(enabled), intervals };
  };

  try {
    const config = await withTimeout(readConfig(), CONFIG_READ_TIMEOUT_MS);
    lastRuntimeConfig = config;
    return config;
  } catch (error) {
    console.warn(
      "[internal-jobs] failed to read runtime config, keeping last config",
      error
    );
    return (
      lastRuntimeConfig ?? {
        enabled: false,
        intervals: new Map(
          jobs.map((job) => [job.name, job.defaultIntervalMinutes * MINUTE_MS])
        ),
      }
    );
  }
}

/**
 * 建立或重置启用周期内的任务时间表。
 *
 * @param state - 调度器状态
 * @param config - 当前运行时配置
 * @param now - 当前时间戳
 * @returns 无返回值
 */
function enableSchedule(
  state: SchedulerState,
  config: SchedulerRuntimeConfig,
  now: number
) {
  state.enabled = true;
  state.generation += 1;
  for (const job of jobs) {
    const existing = state.jobs.get(job.name);
    const nextState: ScheduledJobState = existing ?? {
      running: false,
      awaitingInitialRun: true,
      intervalMs: job.defaultIntervalMinutes * MINUTE_MS,
      scheduleAnchorMs: now,
    };
    // 复用正在执行任务的状态对象，让旧执行周期的 finally 能正确清除 running。
    nextState.awaitingInitialRun = true;
    nextState.intervalMs =
      config.intervals.get(job.name) ?? job.defaultIntervalMinutes * MINUTE_MS;
    nextState.scheduleAnchorMs = now;
    nextState.nextRunAtMs = now + job.initialDelayMs;
    state.jobs.set(job.name, nextState);
  }
  console.info("[internal-jobs] scheduler enabled");
}

/**
 * 停止安排后续任务；正在执行的任务不可安全中断，会允许其自然结束。
 *
 * @param state - 调度器状态
 * @returns 无返回值
 */
function disableSchedule(state: SchedulerState) {
  state.enabled = false;
  state.generation += 1;
  for (const jobState of state.jobs.values()) {
    jobState.nextRunAtMs = undefined;
  }
  console.info("[internal-jobs] scheduler disabled");
}

/**
 * 执行到期任务，并基于完成时刻和最新间隔安排下一次运行。
 *
 * @param schedulerState - 调度器全局状态
 * @param job - 任务定义
 * @param jobState - 任务运行状态
 * @param generation - 启用周期编号，防止旧任务覆盖重新启用后的时间表
 * @returns 无返回值
 */
async function executeScheduledJob(
  schedulerState: SchedulerState,
  job: InternalJob,
  jobState: ScheduledJobState,
  generation: number
) {
  jobState.running = true;
  jobState.nextRunAtMs = undefined;
  try {
    await runJob(job, jobState.intervalMs);
  } finally {
    jobState.running = false;
    if (schedulerState.enabled && schedulerState.generation === generation) {
      jobState.awaitingInitialRun = false;
      jobState.scheduleAnchorMs = Date.now();
      jobState.nextRunAtMs = jobState.scheduleAnchorMs + jobState.intervalMs;
    }
  }
}

/**
 * 将最新开关和间隔应用到内存时间表，并触发到期任务。
 *
 * @param state - 调度器状态
 * @param config - 最新运行时配置
 * @returns 无返回值
 */
function reconcileSchedule(
  state: SchedulerState,
  config: SchedulerRuntimeConfig
) {
  const now = Date.now();
  if (!config.enabled) {
    if (state.enabled) disableSchedule(state);
    return;
  }
  if (!state.enabled) enableSchedule(state, config, now);

  for (const job of jobs) {
    const jobState = state.jobs.get(job.name);
    if (!jobState) continue;
    const nextIntervalMs =
      config.intervals.get(job.name) ?? job.defaultIntervalMinutes * MINUTE_MS;
    if (jobState.intervalMs !== nextIntervalMs) {
      jobState.intervalMs = nextIntervalMs;
      // 首次运行保留初始错峰；之后锚定上次完成时刻重算，使缩短和延长都动态生效。
      if (!jobState.awaitingInitialRun && !jobState.running) {
        jobState.nextRunAtMs = Math.max(
          now,
          jobState.scheduleAnchorMs + nextIntervalMs
        );
      }
    }

    if (
      !jobState.running &&
      jobState.nextRunAtMs !== undefined &&
      jobState.nextRunAtMs <= now
    ) {
      void executeScheduledJob(state, job, jobState, state.generation);
    }
  }
}

/**
 * 安排下一次短周期配置检查。
 *
 * @param state - 调度器状态
 * @param delayMs - 延迟毫秒数
 * @returns 无返回值
 */
function scheduleControlTick(
  state: SchedulerState,
  delayMs = CONFIG_REFRESH_MS
) {
  if (!state.started) return;
  state.timer = setTimeout(() => {
    void runControlTick(state);
  }, delayMs);
  state.timer.unref?.();
}

/**
 * 执行一次配置检查；失败不会终止后续轮询。
 *
 * @param state - 调度器状态
 * @returns 无返回值
 */
async function runControlTick(state: SchedulerState) {
  if (!state.started) return;
  if (state.tickRunning) {
    scheduleControlTick(state);
    return;
  }

  state.tickRunning = true;
  try {
    const config = await getSchedulerRuntimeConfig();
    reconcileSchedule(state, config);
  } catch (error) {
    console.warn("[internal-jobs] scheduler control tick failed", error);
  } finally {
    state.tickRunning = false;
    scheduleControlTick(state);
  }
}

/**
 * 启动常驻控制循环。
 *
 * 初始配置为关闭时也保留轻量轮询，因此后台改为启用后无需重启进程。
 * 构建阶段和测试环境默认不启动，测试可显式切换 NODE_ENV 后验证生命周期。
 *
 * @returns 首次配置检查完成后返回
 */
export async function startInternalJobScheduler() {
  if (process.env.NODE_ENV === "test") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const state = getSchedulerState();
  if (state.started) return;

  state.started = true;
  await runControlTick(state);
  console.info("[internal-jobs] scheduler control loop started");
}

/**
 * 停止控制循环并清理内存时间表，供测试与进程内生命周期管理使用。
 *
 * 正在执行的任务不可安全取消，只阻止其完成后再次排期。
 *
 * @returns 无返回值
 */
export function stopInternalJobScheduler() {
  const state = getSchedulerState();
  state.started = false;
  state.enabled = false;
  state.generation += 1;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  for (const jobState of state.jobs.values()) {
    jobState.nextRunAtMs = undefined;
  }
  state.jobs.clear();
}
