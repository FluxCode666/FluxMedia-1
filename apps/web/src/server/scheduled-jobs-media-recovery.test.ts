/**
 * 媒体 MQ 低频补偿任务测试。
 *
 * 职责：验证扫描结果只重新投递图片与视频最小身份，单个 Redis 失败被隔离且不直接
 * 调用任何媒体业务处理器。
 */
import { describe, expect, it, vi } from "vitest";

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

import type { MediaTaskRecoveryRepository } from "./media-task-recovery-repository";
import {
  type MediaTaskRecoveryJobDependencies,
  runMediaTaskQueueRecovery,
} from "./scheduled-jobs";

/** 创建固定两类恢复任务的只读仓储。 */
function createRepository(): MediaTaskRecoveryRepository {
  return {
    scan: vi.fn(async () => ({
      images: [{ taskId: "task_123", deliveryVersion: 5 }],
      videos: [
        {
          taskId: "video-1",
          stateVersion: 7,
          runAt: new Date("2026-08-04T00:00:00.000Z"),
        },
      ],
    })),
  };
}

describe("scheduled media task MQ recovery", () => {
  it("只补投版本化最小身份并汇总成功数量", async () => {
    const dependencies: MediaTaskRecoveryJobDependencies = {
      repository: createRepository(),
      enqueueImage: vi.fn(async () => undefined),
      enqueueVideo: vi.fn(async () => undefined),
      reportFailure: vi.fn(),
    };

    await expect(runMediaTaskQueueRecovery(dependencies)).resolves.toEqual({
      discovered: 2,
      enqueued: 2,
      failed: 0,
    });
    expect(dependencies.enqueueImage).toHaveBeenCalledWith({
      taskId: "task_123",
      deliveryVersion: 5,
    });
    expect(dependencies.enqueueVideo).toHaveBeenCalledWith({
      taskId: "video-1",
      stateVersion: 7,
      runAt: new Date("2026-08-04T00:00:00.000Z"),
    });
  });

  it("隔离单条 Redis 投递失败并继续补投另一物理队列", async () => {
    const failure = new Error("redis unavailable");
    const dependencies: MediaTaskRecoveryJobDependencies = {
      repository: createRepository(),
      enqueueImage: vi.fn(async () => {
        throw failure;
      }),
      enqueueVideo: vi.fn(async () => undefined),
      reportFailure: vi.fn(),
    };

    await expect(runMediaTaskQueueRecovery(dependencies)).resolves.toEqual({
      discovered: 2,
      enqueued: 1,
      failed: 1,
    });
    expect(dependencies.reportFailure).toHaveBeenCalledWith(
      failure,
      "image",
      "task_123"
    );
    expect(dependencies.enqueueVideo).toHaveBeenCalledTimes(1);
  });
});
