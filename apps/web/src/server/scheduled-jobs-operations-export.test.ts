/**
 * 运营导出内部任务适配测试。
 *
 * 职责：确认处理与过期清理入口先初始化 UOL，并使用各自的 job-scoped cron
 * Principal 和动态批次；所有领域、数据库与存储依赖均使用内存桩。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(async () => undefined),
  invokeOperation: vi.fn(async () => ({ processed: 0 })),
}));

vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));

vi.mock("@repo/shared/credits/core", () => ({
  processExpiredBatches: vi.fn(),
}));
vi.mock("@repo/shared/generation-maintenance", () => ({
  destroyExpiredGenerationPhotos: vi.fn(),
  destroyGenerationPhotosByMaxCount: vi.fn(),
  expireStalePendingGenerations: vi.fn(),
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingSelect: vi.fn(),
}));
vi.mock("@/features/image-generation/video-callback-delivery", () => ({
  runVideoCallbackDeliveryJob: vi.fn(),
}));
vi.mock("@/features/image-generation/video-input-cleanup-queue", () => ({
  runVideoInputCleanupJob: vi.fn(),
}));
vi.mock("@/server/media-task-queues", () => ({
  enqueueImageTask: vi.fn(),
  enqueueVideoTask: vi.fn(),
}));
vi.mock("@/server/media-task-recovery-repository", () => ({
  defaultMediaTaskRecoveryRepository: { scan: vi.fn() },
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import {
  runOperationsExportExpirationJob,
  runOperationsExportProcessingJob,
} from "./scheduled-jobs";

describe("运营导出内部任务", () => {
  beforeEach(() => {
    mocks.ensureUolInitialized.mockClear();
    mocks.invokeOperation.mockClear();
  });

  it.each([
    [
      runOperationsExportProcessingJob,
      "operations.processExports",
      "operations-export",
    ],
    [
      runOperationsExportExpirationJob,
      "operations.expireExports",
      "operations-export-retention",
    ],
  ])("%# 使用独立 cron Principal 和传入批次", async (run, operation, job) => {
    await run(17);

    expect(mocks.ensureUolInitialized).toHaveBeenCalledOnce();
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      operation,
      { limit: 17 },
      { type: "cron", job }
    );
  });
});
