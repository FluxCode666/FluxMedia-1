/**
 * 运营总览 epoch 与网页访问服务的 DB-free 测试。
 *
 * 使用方：Vitest；以固定时钟和内存仓储锁定自然日边界、幂等返回及 epoch 冲突语义。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OperationsFactsRepository } from "./operations-facts-repository";
import {
  initializeOperationsAnalyticsEpoch,
  OperationsFactsServiceError,
  recordOperationsWebVisit,
} from "./operations-facts-service";

const recordWebVisit = vi.fn<OperationsFactsRepository["recordWebVisit"]>();
const initializeEpoch = vi.fn<OperationsFactsRepository["initializeEpoch"]>();
const repository: OperationsFactsRepository = {
  recordWebVisit,
  initializeEpoch,
};

describe("operations facts service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("由服务器时钟和应用时区派生访问日，同日重放沿用仓储幂等结果", async () => {
    const now = new Date("2026-08-12T16:30:00.000Z");
    recordWebVisit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(
      recordOperationsWebVisit(
        { userId: "user-1", timeZone: "Asia/Shanghai" },
        { repository, now: () => now }
      )
    ).resolves.toEqual({ appDate: "2026-08-13", recorded: true });
    await expect(
      recordOperationsWebVisit(
        { userId: "user-1", timeZone: "Asia/Shanghai" },
        { repository, now: () => now }
      )
    ).resolves.toEqual({ appDate: "2026-08-13", recorded: false });
    expect(recordWebVisit).toHaveBeenNthCalledWith(1, {
      userId: "user-1",
      appDate: "2026-08-13",
      visitedAt: now,
    });
  });

  it("跨应用自然日新增另一个访问日且拒绝非法服务器时钟", async () => {
    recordWebVisit.mockResolvedValue(true);
    await recordOperationsWebVisit(
      { userId: "user-1", timeZone: "Asia/Shanghai" },
      {
        repository,
        now: () => new Date("2026-08-13T16:00:00.000Z"),
      }
    );
    expect(recordWebVisit).toHaveBeenCalledWith(
      expect.objectContaining({ appDate: "2026-08-14" })
    );

    await expect(
      recordOperationsWebVisit(
        { userId: "user-1", timeZone: "Asia/Shanghai" },
        { repository, now: () => new Date(Number.NaN) }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("epoch 首次初始化、同值重放和不同值冲突保持稳定", async () => {
    const startsAt = new Date("2026-08-12T16:00:00.000Z");
    const baseInput = {
      appDate: "2026-08-13",
      startsAt: startsAt.toISOString(),
      initializedBy: "deployment-runbook",
      requestId: "epoch-request-1",
    };
    initializeEpoch
      .mockResolvedValueOnce({
        epoch: {
          appDate: baseInput.appDate,
          startsAt,
          initializedBy: baseInput.initializedBy,
          initializationRequestId: baseInput.requestId,
        },
        inserted: true,
      })
      .mockResolvedValueOnce({
        epoch: {
          appDate: baseInput.appDate,
          startsAt,
          initializedBy: baseInput.initializedBy,
          initializationRequestId: baseInput.requestId,
        },
        inserted: false,
      })
      .mockResolvedValueOnce({
        epoch: {
          appDate: "2026-08-12",
          startsAt: new Date("2026-08-11T16:00:00.000Z"),
          initializedBy: "earlier-runbook",
          initializationRequestId: "earlier-request",
        },
        inserted: false,
      });
    const dependencies = {
      repository,
      now: () => new Date("2026-08-13T01:00:00.000Z"),
      createAuditId: () => "audit-1",
    };

    await expect(
      initializeOperationsAnalyticsEpoch(
        baseInput,
        "Asia/Shanghai",
        dependencies
      )
    ).resolves.toMatchObject({ initialized: true });
    await expect(
      initializeOperationsAnalyticsEpoch(
        baseInput,
        "Asia/Shanghai",
        dependencies
      )
    ).resolves.toMatchObject({ initialized: false });
    await expect(
      initializeOperationsAnalyticsEpoch(
        baseInput,
        "Asia/Shanghai",
        dependencies
      )
    ).rejects.toEqual(
      new OperationsFactsServiceError(
        "conflict",
        "运营统计起点已经初始化为另一组固定值"
      )
    );
  });

  it("epoch UTC 瞬间必须精确等于应用自然日零点", async () => {
    await expect(
      initializeOperationsAnalyticsEpoch(
        {
          appDate: "2026-08-13",
          startsAt: "2026-08-13T00:00:00.000Z",
          initializedBy: "deployment-runbook",
          requestId: "epoch-request-1",
        },
        "Asia/Shanghai",
        { repository }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(initializeEpoch).not.toHaveBeenCalled();
  });
});
