/**
 * 媒体 MQ 与图片租约低频补偿任务测试。
 *
 * 职责：验证图片补投携带持久 priority、admission 丢失时重新容量裁决、终态
 * release/ack 收敛，以及单条 Redis 故障不会阻断另一物理队列。
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

import type { ImageAsyncTaskRecord } from "@/features/image-generation/image-async-task-repository";
import type { MediaTaskRecoveryRepository } from "./media-task-recovery-repository";
import {
  type MediaTaskRecoveryJobDependencies,
  runMediaTaskQueueRecovery,
} from "./scheduled-jobs";

const NOW = new Date("2026-08-04T00:00:00.000Z");
const EXPIRES_AT = new Date(NOW.getTime() + 22 * 60_000);

/** 创建覆盖四类图片恢复和一条视频补投的扫描仓储。 */
function createRepository(): MediaTaskRecoveryRepository {
  return {
    scan: vi.fn(async () => ({
      images: [
        {
          taskId: "task_mq",
          deliveryVersion: 5,
          dueAt: NOW,
          priority: 8,
          recoveryKind: "mq" as const,
        },
      ],
      imageAdmissions: [
        {
          taskId: "task_admission",
          userId: "user-1",
          effectiveUserConcurrency: 20,
          token: "admission-1",
          expiresAt: EXPIRES_AT,
          renewalDueAt: NOW,
        },
      ],
      imageTerminalReleases: [
        {
          taskId: "task_terminal",
          userId: "user-1",
          token: "admission-2",
          expiresAt: EXPIRES_AT,
        },
      ],
      videos: [
        {
          taskId: "video-1",
          stateVersion: 7,
          runAt: NOW,
        },
      ],
    })),
  };
}

/** 创建所有恢复副作用可观察的依赖桩。 */
function createDependencies(): MediaTaskRecoveryJobDependencies {
  const taskRecord = {} as ImageAsyncTaskRecord;
  return {
    repository: createRepository(),
    imageTaskRepository: {
      markMqDelivered: vi.fn(async () => taskRecord),
      prepareClaimRecoveryDelivery: vi.fn(async () => taskRecord),
      deferAdmissionRenewal: vi.fn(async () => taskRecord),
      updateAdmissionLease: vi.fn(async () => taskRecord),
      markAdmissionReleased: vi.fn(async () => taskRecord),
    },
    enqueueImage: vi.fn(async () => undefined),
    enqueueVideo: vi.fn(async () => undefined),
    acquireImageAdmission: vi.fn(async () => ({
      status: "acquired" as const,
      lease: {
        token: "admission-1",
        userKey: "user-key-1",
        expiresAt: EXPIRES_AT.getTime(),
      },
    })),
    renewImageAdmission: vi.fn(async () => ({
      status: "renewed" as const,
      expiresAt: EXPIRES_AT.getTime(),
    })),
    releaseImageAdmission: vi.fn(async () => undefined),
    now: vi.fn(() => NOW),
    reportFailure: vi.fn(),
  };
}

describe("scheduled media task recovery", () => {
  it("补投、续期和终态释放分别确认并汇总", async () => {
    const dependencies = createDependencies();

    await expect(runMediaTaskQueueRecovery(dependencies)).resolves.toEqual({
      discovered: 4,
      enqueued: 2,
      renewed: 1,
      released: 1,
      deferred: 0,
      failed: 0,
    });
    expect(dependencies.enqueueImage).toHaveBeenCalledWith({
      taskId: "task_mq",
      deliveryVersion: 5,
      priority: 8,
    });
    expect(
      dependencies.imageTaskRepository.markMqDelivered
    ).toHaveBeenCalledWith({
      taskId: "task_mq",
      deliveryVersion: 5,
      mqDeliveryDueAt: NOW,
      now: NOW,
    });
    expect(
      dependencies.imageTaskRepository.updateAdmissionLease
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task_admission",
        admissionLeaseToken: "admission-1",
      })
    );
    expect(dependencies.releaseImageAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ token: "admission-2" })
    );
    expect(
      dependencies.imageTaskRepository.markAdmissionReleased
    ).toHaveBeenCalledWith({
      taskId: "task_terminal",
      admissionLeaseToken: "admission-2",
      now: NOW,
    });
  });

  it("admission token 丢失时重新容量裁决，满载则保留 due 延后", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.renewImageAdmission).mockResolvedValue({
      status: "lost",
    });
    vi.mocked(dependencies.acquireImageAdmission).mockResolvedValue({
      status: "blocked",
      reason: "user",
    });

    await expect(
      runMediaTaskQueueRecovery(dependencies)
    ).resolves.toMatchObject({
      renewed: 0,
      deferred: 1,
      failed: 0,
    });
    expect(dependencies.acquireImageAdmission).toHaveBeenCalledWith({
      userId: "user-1",
      userConcurrency: 20,
      token: "admission-1",
    });
    expect(
      dependencies.imageTaskRepository.updateAdmissionLease
    ).not.toHaveBeenCalled();
    expect(
      dependencies.imageTaskRepository.deferAdmissionRenewal
    ).toHaveBeenCalledWith({
      taskId: "task_admission",
      admissionLeaseToken: "admission-1",
      expectedRenewalDueAt: NOW,
      nextRenewalDueAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });
  });

  it("claim 恢复先原子生成新投递版本再按新 due 确认", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.repository.scan).mockResolvedValue({
      images: [
        {
          taskId: "task_claim",
          deliveryVersion: 6,
          dueAt: NOW,
          priority: 3,
          recoveryKind: "claim",
        },
      ],
      imageAdmissions: [],
      imageTerminalReleases: [],
      videos: [],
    });
    vi.mocked(
      dependencies.imageTaskRepository.prepareClaimRecoveryDelivery
    ).mockResolvedValue({
      mqDeliveryVersion: 7,
      mqDeliveryDueAt: NOW,
    } as ImageAsyncTaskRecord);

    await expect(runMediaTaskQueueRecovery(dependencies)).resolves.toEqual({
      discovered: 1,
      enqueued: 1,
      renewed: 0,
      released: 0,
      deferred: 0,
      failed: 0,
    });
    expect(
      dependencies.imageTaskRepository.prepareClaimRecoveryDelivery
    ).toHaveBeenCalledWith({
      taskId: "task_claim",
      deliveryVersion: 6,
      claimRecoveryDueAt: NOW,
      now: NOW,
    });
    expect(dependencies.enqueueImage).toHaveBeenCalledWith({
      taskId: "task_claim",
      deliveryVersion: 7,
      priority: 3,
    });
    expect(
      dependencies.imageTaskRepository.markMqDelivered
    ).toHaveBeenCalledWith({
      taskId: "task_claim",
      deliveryVersion: 7,
      mqDeliveryDueAt: NOW,
      now: NOW,
    });
  });

  it("admission 重新取得后若任务已终态则撤销迟到租约", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.renewImageAdmission).mockResolvedValue({
      status: "lost",
    });
    vi.mocked(
      dependencies.imageTaskRepository.updateAdmissionLease
    ).mockResolvedValue(null);

    await expect(
      runMediaTaskQueueRecovery(dependencies)
    ).resolves.toMatchObject({
      renewed: 0,
      deferred: 1,
      failed: 0,
    });
    expect(dependencies.releaseImageAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ token: "admission-1" })
    );
  });

  it("隔离单条 MQ 失败并继续处理视频和租约恢复", async () => {
    const dependencies = createDependencies();
    const failure = new Error("redis unavailable");
    vi.mocked(dependencies.enqueueImage).mockRejectedValue(failure);

    await expect(runMediaTaskQueueRecovery(dependencies)).resolves.toEqual({
      discovered: 4,
      enqueued: 1,
      renewed: 1,
      released: 1,
      deferred: 0,
      failed: 1,
    });
    expect(dependencies.reportFailure).toHaveBeenCalledWith(
      failure,
      "image",
      "task_mq"
    );
    expect(dependencies.enqueueVideo).toHaveBeenCalledTimes(1);
    expect(dependencies.renewImageAdmission).toHaveBeenCalledTimes(1);
  });
});
