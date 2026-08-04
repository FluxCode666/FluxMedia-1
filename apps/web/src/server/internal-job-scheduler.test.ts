/**
 * 内置调度器运行时配置单测。
 *
 * 所有数据库、配置和任务依赖均使用内存桩，验证动态启停与间隔重排，不产生外部 I/O。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  imageMaintenance: vi.fn(async () => undefined),
  creditsExpire: vi.fn(async () => undefined),
  videoRecovery: vi.fn(async () => undefined),
  adobeCredentialHealth: vi.fn(async () => undefined),
  adobeCredentialNotifications: vi.fn(async () => undefined),
  adobeCredentialRetention: vi.fn(async () => undefined),
}));

const database = vi.hoisted(() => {
  let transactionActive = false;
  const selectBuilder = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(async () => []),
  };
  selectBuilder.from.mockReturnValue(selectBuilder);
  selectBuilder.where.mockReturnValue(selectBuilder);

  const insertBuilder = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(async () => undefined),
  };
  insertBuilder.values.mockReturnValue(insertBuilder);

  const tx = {
    execute: vi.fn(async () => [{ locked: true }]),
    select: vi.fn(() => selectBuilder),
    insert: vi.fn(() => insertBuilder),
  };
  return {
    insert: vi.fn(() => insertBuilder),
    isTransactionActive: () => transactionActive,
    transaction: vi.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => {
        transactionActive = true;
        try {
          return await callback(tx);
        } finally {
          transactionActive = false;
        }
      }
    ),
  };
});

vi.mock("@repo/database", () => ({
  db: database,
  systemSetting: {
    key: "key",
    value: "value",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({ type: "eq" })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: vi.fn(async (key: string, fallback: boolean) => {
    const value = runtime.settings.get(key);
    return typeof value === "boolean" ? value : fallback;
  }),
  getRuntimeSettingNumber: vi.fn(async (key: string, fallback: number) => {
    const value = Number(runtime.settings.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }),
}));

vi.mock("./scheduled-jobs", () => ({
  runImageMaintenanceJob: runtime.imageMaintenance,
  runCreditsExpireJob: runtime.creditsExpire,
  runVideoRecoveryJob: runtime.videoRecovery,
  runAdobeCredentialHealthJob: runtime.adobeCredentialHealth,
  runAdobeCredentialNotificationDrainJob: runtime.adobeCredentialNotifications,
  runAdobeCredentialHealthCleanupJob: runtime.adobeCredentialRetention,
}));

type SchedulerModule = typeof import("./internal-job-scheduler");
let scheduler: SchedulerModule | undefined;

/**
 * 重新导入调度模块并清除 globalThis 单例。
 *
 * @returns 干净的调度模块实例
 */
async function importFreshScheduler() {
  vi.resetModules();
  delete (
    globalThis as typeof globalThis & {
      __gpt2imageInternalJobScheduler?: unknown;
    }
  ).__gpt2imageInternalJobScheduler;
  scheduler = await import("./internal-job-scheduler");
  return scheduler;
}

describe("internal job scheduler runtime configuration", () => {
  beforeEach(() => {
    runtime.settings.clear();
    runtime.imageMaintenance.mockClear();
    runtime.creditsExpire.mockClear();
    runtime.videoRecovery.mockClear();
    runtime.adobeCredentialHealth.mockClear();
    runtime.adobeCredentialNotifications.mockClear();
    runtime.adobeCredentialRetention.mockClear();
    database.transaction.mockClear();
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    scheduler?.stopInternalJobScheduler();
    scheduler = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("observes disabled-to-enabled and enabled-to-disabled changes", async () => {
    runtime.settings.set("INTERNAL_JOB_SCHEDULER_ENABLED", false);
    const current = await importFreshScheduler();
    await current.startInternalJobScheduler();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.imageMaintenance).not.toHaveBeenCalled();

    runtime.settings.set("INTERNAL_JOB_SCHEDULER_ENABLED", true);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.imageMaintenance).toHaveBeenCalledTimes(1);
    expect(runtime.videoRecovery).toHaveBeenCalled();

    runtime.settings.set("INTERNAL_JOB_SCHEDULER_ENABLED", false);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runtime.imageMaintenance).toHaveBeenCalledTimes(1);
  });

  it("reschedules from the last completion when an interval is shortened", async () => {
    runtime.settings.set("INTERNAL_JOB_SCHEDULER_ENABLED", true);
    runtime.settings.set(
      "INTERNAL_JOB_IMAGES_MAINTENANCE_INTERVAL_MINUTES",
      10
    );
    const current = await importFreshScheduler();
    await current.startInternalJobScheduler();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.imageMaintenance).toHaveBeenCalledTimes(1);

    runtime.settings.set("INTERNAL_JOB_IMAGES_MAINTENANCE_INTERVAL_MINUTES", 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(55_000);

    expect(runtime.imageMaintenance).toHaveBeenCalledTimes(2);
  });

  it("在 advisory lock 事务提交后才执行视频恢复 I/O", async () => {
    runtime.settings.set("INTERNAL_JOB_SCHEDULER_ENABLED", true);
    runtime.videoRecovery.mockImplementationOnce(async () => {
      expect(database.isTransactionActive()).toBe(false);
    });
    const current = await importFreshScheduler();
    await current.startInternalJobScheduler();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(runtime.videoRecovery).toHaveBeenCalledTimes(1);
  });
});
