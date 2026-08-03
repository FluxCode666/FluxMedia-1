/**
 * Adobe 健康内部任务适配测试。
 *
 * 职责：确认三个调度入口均先初始化 UOL，再使用精确 job-scoped cron Principal；
 * 不加载数据库、Adobe transport、邮件或 Webhook。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(async () => undefined),
  invokeOperation: vi.fn(async () => ({
    claimed: 0,
    completed: 0,
    failed: 0,
  })),
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
  runAdobeCredentialHealthCleanupJob,
  runAdobeCredentialHealthJob,
  runAdobeCredentialNotificationDrainJob,
} from "./scheduled-jobs";

describe("Adobe 凭据健康内部任务", () => {
  beforeEach(() => {
    mocks.ensureUolInitialized.mockClear();
    mocks.invokeOperation.mockClear();
  });

  it.each([
    [
      runAdobeCredentialHealthJob,
      "pool.scanAdobeCredentialHealth",
      "adobe-credential-health",
    ],
    [
      runAdobeCredentialNotificationDrainJob,
      "pool.drainAdobeCredentialNotifications",
      "adobe-credential-notification-delivery",
    ],
    [
      runAdobeCredentialHealthCleanupJob,
      "pool.cleanupAdobeCredentialHealthHistory",
      "adobe-credential-health-retention",
    ],
  ])("%# 使用精确 cron Principal", async (run, operation, job) => {
    await run();

    expect(mocks.ensureUolInitialized).toHaveBeenCalledOnce();
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      operation,
      { batchSize: 25 },
      { type: "cron", job }
    );
  });
});
