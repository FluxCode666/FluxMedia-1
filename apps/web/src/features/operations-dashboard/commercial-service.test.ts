/**
 * 运营总览商业化快照服务测试。
 *
 * 使用内存 reader 覆盖待支付、支付后未履约、失败和履约阶段，验证多币种收入、
 * 付费转化零分母、上一周期比较及上线前特殊状态。
 */
import { describe, expect, it, vi } from "vitest";

import type {
  OperationsCommercialRepository,
  OperationsCommercialSnapshotReader,
} from "./commercial-repository";
import {
  buildOperationsCommercialSnapshot,
  loadOperationsCommercialSnapshot,
  type OperationsCommercialServiceError,
} from "./commercial-service";

type ReaderOverrides = Partial<OperationsCommercialSnapshotReader>;

/** 构造有固定时钟和 epoch 的商业化内存 reader。 */
function createReader(
  overrides: ReaderOverrides = {}
): OperationsCommercialSnapshotReader {
  return {
    readHeader: vi.fn().mockResolvedValue({
      asOf: new Date("2026-08-10T12:00:00.000Z"),
      epoch: {
        appDate: "2026-08-01",
        startsAt: new Date("2026-07-31T16:00:00.000Z"),
      },
    }),
    readLifecycleCounts: vi.fn().mockResolvedValue({
      createdOrders: 0,
      pendingOrders: 0,
      paymentConfirmedOrders: 0,
      paidNotFulfilledOrders: 0,
      fulfilledOrders: 0,
      failedOrders: 0,
    }),
    readRevenue: vi.fn().mockResolvedValue([]),
    readPayingUserCount: vi.fn().mockResolvedValue(0),
    readActivityUserCount: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

/** 把 reader 固定到一次快照仓储调用。 */
function createRepository(
  reader: OperationsCommercialSnapshotReader
): OperationsCommercialRepository {
  return {
    withReadOnlySnapshot: (work) => work(reader),
  };
}

describe("operations commercial service", () => {
  it("epoch 未初始化时在任何商业化查询前明确失败", async () => {
    const reader = createReader({
      readHeader: vi.fn().mockResolvedValue({
        asOf: new Date("2026-08-10T12:00:00.000Z"),
        epoch: null,
      }),
    });

    await expect(
      loadOperationsCommercialSnapshot(
        {},
        "Asia/Shanghai",
        createRepository(reader)
      )
    ).rejects.toMatchObject({
      code: "not_ready",
    } satisfies Partial<OperationsCommercialServiceError>);
    expect(reader.readLifecycleCounts).not.toHaveBeenCalled();
  });

  it("完整保留待支付、支付后未履约、失败和履约阶段及上一周期比较", async () => {
    const readLifecycleCounts = vi
      .fn()
      .mockResolvedValueOnce({
        createdOrders: 10,
        pendingOrders: 3,
        paymentConfirmedOrders: 6,
        paidNotFulfilledOrders: 2,
        fulfilledOrders: 4,
        failedOrders: 3,
      })
      .mockResolvedValueOnce({
        createdOrders: 5,
        pendingOrders: 1,
        paymentConfirmedOrders: 4,
        paidNotFulfilledOrders: 1,
        fulfilledOrders: 3,
        failedOrders: 1,
      });
    const reader = createReader({ readLifecycleCounts });

    const snapshot = await loadOperationsCommercialSnapshot(
      {
        range: { kind: "custom", from: "2026-08-08", to: "2026-08-10" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.lifecycle.pendingOrders).toMatchObject({
      current: 3,
      previous: 1,
    });
    expect(snapshot.lifecycle.paidNotFulfilledOrders).toMatchObject({
      current: 2,
      previous: 1,
    });
    expect(snapshot.lifecycle.failedOrders.current).toBe(3);
    expect(snapshot.lifecycle.fulfilledOrders.current).toBe(4);
    expect(readLifecycleCounts).toHaveBeenCalledTimes(2);
  });

  it("相同数值的不同币种保持分开并按币种比较", async () => {
    const reader = createReader({
      readRevenue: vi
        .fn()
        .mockResolvedValueOnce([
          { currency: "USD", amountMinor: 1_000 },
          { currency: "CNY", amountMinor: 1_000 },
        ])
        .mockResolvedValueOnce([
          { currency: "USD", amountMinor: 500 },
          { currency: "CNY", amountMinor: 250 },
        ]),
    });

    const snapshot = await loadOperationsCommercialSnapshot(
      {
        range: { kind: "custom", from: "2026-08-08", to: "2026-08-10" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.revenue.current).toEqual([
      { currency: "CNY", amountMinor: 1_000 },
      { currency: "USD", amountMinor: 1_000 },
    ]);
    expect(snapshot.revenue.comparison).toEqual([
      expect.objectContaining({ currency: "CNY", changePercent: 300 }),
      expect.objectContaining({ currency: "USD", changePercent: 100 }),
    ]);
    expect(snapshot.revenue.disclaimer).toBe("不含线下退款");
  });

  it("两个付费转化使用相同付费用户分子且零分母明确不可比较", async () => {
    const readPayingUserCount = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    const readActivityUserCount = vi.fn(async (kind: "login" | "creation") =>
      kind === "login" ? 4 : 0
    );
    const reader = createReader({
      readPayingUserCount,
      readActivityUserCount,
    });

    const snapshot = await loadOperationsCommercialSnapshot(
      {
        range: { kind: "custom", from: "2026-08-08", to: "2026-08-10" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.conversion.fromLogin.current).toEqual({
      paidUsers: 2,
      activeUsers: 4,
      rate: 0.5,
    });
    expect(snapshot.conversion.fromCreation.current).toEqual({
      paidUsers: 2,
      activeUsers: 0,
      rate: null,
    });
    expect(snapshot.conversion.fromCreation.comparison).toEqual({
      status: "not_comparable",
      reason: "zero_current_denominator",
    });
  });

  it("顶层快照复用增长模块的两期活跃计数而不重复查询", async () => {
    const reader = createReader();

    const snapshot = await buildOperationsCommercialSnapshot(
      {
        range: { kind: "custom", from: "2026-08-08", to: "2026-08-10" },
        granularity: "day",
      },
      "Asia/Shanghai",
      reader,
      await reader.readHeader(),
      {
        current: { payment: 3, creation: 6, login: 12 },
        previous: { payment: 2, creation: 4, login: 8 },
      }
    );

    expect(snapshot.conversion.fromCreation.current).toEqual({
      paidUsers: 3,
      activeUsers: 6,
      rate: 0.5,
    });
    expect(snapshot.conversion.fromLogin.previous).toEqual({
      paidUsers: 2,
      activeUsers: 8,
      rate: 0.25,
    });
    expect(reader.readPayingUserCount).not.toHaveBeenCalled();
    expect(reader.readActivityUserCount).not.toHaveBeenCalled();
  });

  it("范围完全位于 epoch 前时不执行商业化事实查询", async () => {
    const reader = createReader();

    const snapshot = await loadOperationsCommercialSnapshot(
      {
        range: { kind: "custom", from: "2026-07-28", to: "2026-07-30" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.lifecycle.createdOrders.status).toBe("pre_epoch");
    expect(snapshot.revenue.status).toBe("pre_epoch");
    expect(snapshot.conversion.fromLogin.status).toBe("pre_epoch");
    expect(reader.readLifecycleCounts).not.toHaveBeenCalled();
    expect(reader.readRevenue).not.toHaveBeenCalled();
  });

  it("拒绝仓储返回重复币种或非法漏斗集合", async () => {
    const duplicateCurrencyReader = createReader({
      readRevenue: vi.fn().mockResolvedValue([
        { currency: "CNY", amountMinor: 100 },
        { currency: "cny", amountMinor: 50 },
      ]),
    });
    await expect(
      loadOperationsCommercialSnapshot(
        {},
        "Asia/Shanghai",
        createRepository(duplicateCurrencyReader)
      )
    ).rejects.toMatchObject({ code: "invalid_data" });

    const invalidLifecycleReader = createReader({
      readLifecycleCounts: vi.fn().mockResolvedValue({
        createdOrders: 1,
        pendingOrders: 2,
        paymentConfirmedOrders: 0,
        paidNotFulfilledOrders: 0,
        fulfilledOrders: 0,
        failedOrders: 0,
      }),
    });
    await expect(
      loadOperationsCommercialSnapshot(
        {},
        "Asia/Shanghai",
        createRepository(invalidLifecycleReader)
      )
    ).rejects.toMatchObject({ code: "invalid_data" });
  });
});
