/**
 * 管理端支付应用服务测试。
 *
 * 覆盖自然月时区边界、多币种补零、签名 cursor 的前后页语义及篡改/跨筛选拒绝。
 * 测试通过仓储端口注入数据，不连接数据库。
 */
import { describe, expect, it } from "vitest";

import type {
  AdminPaymentOrderQuery,
  AdminPaymentOrderRow,
  AdminPaymentRepository,
} from "./admin-payment-service";
import {
  AdminPaymentServiceError,
  loadAdminPaymentOrders,
  loadAdminPaymentOverview,
  resolveAdminPaymentMonth,
} from "./admin-payment-service";

/** 创建最小合法订单行，允许测试覆盖排序键和业务字段。 */
function makeOrder(
  id: string,
  createdAt: string,
  overrides: Partial<AdminPaymentOrderRow> = {}
): AdminPaymentOrderRow {
  return {
    id,
    userId: "user-1",
    userEmail: "buyer@example.com",
    provider: "alipay_f2f",
    purpose: "credit_top_up",
    status: "fulfilled",
    currency: "CNY",
    amountMinor: 1000,
    creditsAmount: 100,
    providerTradeNo: `trade-${id}`,
    createdAt,
    updatedAt: createdAt,
    expiresAt: null,
    fulfilledAt: createdAt,
    ...overrides,
  };
}

/** 创建可按需覆盖的 DB-free 仓储。 */
function makeRepository(
  overrides: Partial<AdminPaymentRepository> = {}
): AdminPaymentRepository {
  return {
    readOverviewAggregates: async () => [],
    readOrders: async () => [],
    searchUsers: async () => [],
    ...overrides,
  };
}

describe("admin payment overview", () => {
  it("uses the full app-time-zone natural month and keeps currencies separate", async () => {
    const repository = makeRepository({
      readOverviewAggregates: async (input) => {
        expect(input.start.toISOString()).toBe("2026-06-30T16:00:00.000Z");
        expect(input.end.toISOString()).toBe("2026-07-31T16:00:00.000Z");
        expect(input.timeZone).toBe("Asia/Shanghai");
        return [
          {
            date: "2026-07-01",
            currency: "CNY",
            amountMinor: 2500,
            orderCount: 2,
          },
          {
            date: "2026-07-01",
            currency: "USD",
            amountMinor: 999,
            orderCount: 1,
          },
          {
            date: "2026-07-03",
            currency: "CNY",
            amountMinor: 500,
            orderCount: 1,
          },
        ];
      },
    });

    const output = await loadAdminPaymentOverview(
      {
        timeZone: "Asia/Shanghai",
        input: {},
        now: new Date("2026-07-15T16:00:00.000Z"),
      },
      { repository }
    );

    expect(output.month).toBe("2026-07");
    expect(output.daily).toHaveLength(31);
    expect(output.successfulOrderCount).toBe(4);
    expect(output.activeDayCount).toBe(2);
    expect(output.revenueTotals).toEqual([
      { currency: "CNY", amountMinor: 3000 },
      { currency: "USD", amountMinor: 999 },
    ]);
    expect(output.daily[1]).toEqual({
      date: "2026-07-02",
      orderCount: 0,
      revenue: [
        { currency: "CNY", amountMinor: 0 },
        { currency: "USD", amountMinor: 0 },
      ],
    });
  });

  it("rejects future reporting months", () => {
    expect(() =>
      resolveAdminPaymentMonth({
        month: "2026-08",
        timeZone: "UTC",
        asOf: new Date("2026-07-28T00:00:00.000Z"),
      })
    ).toThrow(AdminPaymentServiceError);
  });

  it("rejects duplicate date and currency aggregates", async () => {
    const repository = makeRepository({
      readOverviewAggregates: async () => [
        {
          date: "2026-07-01",
          currency: "CNY",
          amountMinor: 100,
          orderCount: 1,
        },
        {
          date: "2026-07-01",
          currency: "CNY",
          amountMinor: 200,
          orderCount: 1,
        },
      ],
    });
    await expect(
      loadAdminPaymentOverview(
        {
          timeZone: "UTC",
          input: { month: "2026-07" },
          now: new Date("2026-07-28T00:00:00.000Z"),
        },
        { repository }
      )
    ).rejects.toThrow(AdminPaymentServiceError);
  });
});

describe("admin payment order cursor", () => {
  it("paginates forward and issues a previous cursor bound to the actor", async () => {
    const seenQueries: AdminPaymentOrderQuery[] = [];
    const repository = makeRepository({
      readOrders: async (query) => {
        seenQueries.push(query);
        return query.cursor?.direction === "next"
          ? [makeOrder("order-1", "2026-07-01T00:00:00.000Z")]
          : [
              makeOrder("order-3", "2026-07-03T00:00:00.000Z"),
              makeOrder("order-2", "2026-07-02T00:00:00.000Z"),
              makeOrder("order-1", "2026-07-01T00:00:00.000Z"),
            ];
      },
    });
    const common = {
      actorUserId: "admin-1",
      now: new Date("2026-07-28T00:00:00.000Z"),
    };
    const first = await loadAdminPaymentOrders(
      { ...common, input: { limit: 2, status: "fulfilled" } },
      { repository, tokenSecret: "test-secret" }
    );
    expect(first.records.map((record) => record.id)).toEqual([
      "order-3",
      "order-2",
    ]);
    expect(first.previousCursor).toBeNull();
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await loadAdminPaymentOrders(
      {
        ...common,
        input: {
          limit: 2,
          status: "fulfilled",
          cursor: first.nextCursor ?? undefined,
        },
      },
      { repository, tokenSecret: "test-secret" }
    );
    expect(seenQueries[1]?.cursor).toMatchObject({
      direction: "next",
      id: "order-2",
    });
    expect(second.records.map((record) => record.id)).toEqual(["order-1"]);
    expect(second.previousCursor).toBeTypeOf("string");
    expect(second.nextCursor).toBeNull();
  });

  it("rejects tampered cursors and cross-filter reuse", async () => {
    const repository = makeRepository({
      readOrders: async () => [
        makeOrder("order-2", "2026-07-02T00:00:00.000Z"),
        makeOrder("order-1", "2026-07-01T00:00:00.000Z"),
      ],
    });
    const first = await loadAdminPaymentOrders(
      {
        actorUserId: "admin-1",
        input: { limit: 1, status: "fulfilled" },
        now: new Date("2026-07-28T00:00:00.000Z"),
      },
      { repository, tokenSecret: "test-secret" }
    );
    const cursor = first.nextCursor ?? "";

    await expect(
      loadAdminPaymentOrders(
        {
          actorUserId: "admin-1",
          input: { limit: 1, status: "fulfilled", cursor: `${cursor}x` },
          now: new Date("2026-07-28T00:00:00.000Z"),
        },
        { repository, tokenSecret: "test-secret" }
      )
    ).rejects.toThrow(AdminPaymentServiceError);

    await expect(
      loadAdminPaymentOrders(
        {
          actorUserId: "admin-1",
          input: { limit: 1, status: "pending", cursor },
          now: new Date("2026-07-28T00:00:00.000Z"),
        },
        { repository, tokenSecret: "test-secret" }
      )
    ).rejects.toThrow(AdminPaymentServiceError);
  });
});
