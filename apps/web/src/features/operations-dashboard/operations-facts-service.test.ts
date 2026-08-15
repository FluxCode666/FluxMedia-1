/**
 * 运营总览 epoch 与网页访问服务的 DB-free 测试。
 *
 * 使用方：Vitest；以固定时钟和内存仓储锁定自然日边界、锁内派生与幂等跳过语义。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OperationsFactsRepository } from "./operations-facts-repository";
import {
  ensureCurrentOperationsAnalyticsEpoch,
  recordOperationsWebVisit,
} from "./operations-facts-service";

const recordWebVisit = vi.fn<OperationsFactsRepository["recordWebVisit"]>();
const ensureEpoch = vi.fn<OperationsFactsRepository["ensureEpoch"]>();
const repository: OperationsFactsRepository = {
  recordWebVisit,
  ensureEpoch,
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

  it("自动初始化在仓储锁内使用应用时区当前日，已有 epoch 不再读取时钟", async () => {
    const currentStart = new Date("2026-08-16T16:00:00.000Z");
    const existingStart = new Date("2026-08-15T16:00:00.000Z");
    ensureEpoch
      .mockImplementationOnce(async (createInput) => {
        const input = createInput();
        expect(input).toEqual({
          appDate: "2026-08-17",
          startsAt: currentStart,
          initializedBy: "release-v0.25.1",
          initializationRequestId: "operations-epoch-2026-08-17",
          auditId: "audit-current",
          createdAt: new Date("2026-08-16T16:30:00.000Z"),
        });
        return {
          epoch: {
            appDate: input.appDate,
            startsAt: input.startsAt,
            initializedBy: input.initializedBy,
            initializationRequestId: input.initializationRequestId,
          },
          inserted: true,
        };
      })
      .mockImplementationOnce(async (_createInput) => ({
        epoch: {
          appDate: "2026-08-16",
          startsAt: existingStart,
          initializedBy: "release-v0.25.1",
          initializationRequestId: "operations-epoch-2026-08-16",
        },
        inserted: false,
      }));
    const now = vi.fn(() => new Date("2026-08-16T16:30:00.000Z"));
    const dependencies = {
      repository,
      now,
      createAuditId: () => "audit-current",
    };

    await expect(
      ensureCurrentOperationsAnalyticsEpoch(
        { initializedBy: "release-v0.25.1" },
        "Asia/Shanghai",
        dependencies
      )
    ).resolves.toEqual({
      appDate: "2026-08-17",
      startsAt: "2026-08-16T16:00:00.000Z",
      initialized: true,
    });
    expect(now).toHaveBeenCalledOnce();

    await expect(
      ensureCurrentOperationsAnalyticsEpoch(
        { initializedBy: "release-v0.25.2" },
        "Asia/Shanghai",
        dependencies
      )
    ).resolves.toEqual({
      appDate: "2026-08-16",
      startsAt: "2026-08-15T16:00:00.000Z",
      initialized: false,
    });
    expect(now).toHaveBeenCalledOnce();
  });

  it("自动初始化在锁内拒绝非法服务器时钟", async () => {
    ensureEpoch.mockImplementationOnce(async (createInput) => {
      createInput();
      throw new Error("候选生成器应在非法时钟时抛错");
    });

    await expect(
      ensureCurrentOperationsAnalyticsEpoch(
        { initializedBy: "release-v0.25.1" },
        "Asia/Shanghai",
        { repository, now: () => new Date(Number.NaN) }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
  });
});
