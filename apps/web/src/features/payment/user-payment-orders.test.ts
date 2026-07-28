/**
 * 用户侧最近充值订单服务测试。
 *
 * 证明查询只把当前 Principal 的 userId 交给仓储，并锁定用户态状态映射和安全输出
 * 字段。数据库模块使用最小 mock，测试本身不连接 PostgreSQL。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/database/schema", () => ({ paymentOrder: {} }));

import {
  loadUserRecentPaymentOrders,
  type UserPaymentOrderRepository,
} from "./user-payment-orders";

/** 创建可断言调用参数的最近订单仓储。 */
function createRepository(): UserPaymentOrderRepository {
  return {
    listRecentByUser: vi.fn().mockResolvedValue([
      {
        id: "order-pending",
        provider: "alipay_f2f",
        purpose: "credit_top_up",
        status: "pending",
        currency: "CNY",
        amountMinor: 1_000,
        creditsAmount: 100,
        createdAt: new Date("2026-07-28T03:00:00.000Z"),
        expiresAt: new Date("2026-07-28T04:00:00.000Z"),
        fulfilledAt: null,
      },
      {
        id: "order-fulfilled",
        provider: "creem",
        purpose: "credit_package",
        status: "fulfilled",
        currency: "USD",
        amountMinor: 2_500,
        creditsAmount: 300,
        createdAt: new Date("2026-07-27T03:00:00.000Z"),
        expiresAt: null,
        fulfilledAt: new Date("2026-07-27T03:02:00.000Z"),
      },
    ]),
  };
}

describe("loadUserRecentPaymentOrders", () => {
  it("只按当前用户读取有界订单并映射为用户态状态", async () => {
    const repository = createRepository();

    const output = await loadUserRecentPaymentOrders(
      {
        userId: "session-user",
        input: { limit: 2 },
        timeZone: "Asia/Shanghai",
        asOf: new Date("2026-07-28T03:30:00.000Z"),
      },
      { repository }
    );

    expect(repository.listRecentByUser).toHaveBeenCalledWith({
      userId: "session-user",
      limit: 2,
    });
    expect(output).toEqual({
      asOf: "2026-07-28T03:30:00.000Z",
      timeZone: "Asia/Shanghai",
      records: [
        {
          id: "order-pending",
          provider: "alipay_f2f",
          purpose: "credit_top_up",
          status: "waiting_payment",
          currency: "CNY",
          amountMinor: 1_000,
          creditsAmount: 100,
          createdAt: "2026-07-28T03:00:00.000Z",
          fulfilledAt: null,
        },
        {
          id: "order-fulfilled",
          provider: "creem",
          purpose: "credit_package",
          status: "fulfilled",
          currency: "USD",
          amountMinor: 2_500,
          creditsAmount: 300,
          createdAt: "2026-07-27T03:00:00.000Z",
          fulfilledAt: "2026-07-27T03:02:00.000Z",
        },
      ],
    });
    expect(output.records[0]).not.toHaveProperty("userId");
    expect(output.records[0]).not.toHaveProperty("providerTradeNo");
  });

  it("按统一快照时间把已超时未支付订单标记为已过期", async () => {
    const repository = createRepository();

    const output = await loadUserRecentPaymentOrders(
      {
        userId: "session-user",
        input: {},
        timeZone: "UTC",
        asOf: new Date("2026-07-28T05:00:00.000Z"),
      },
      { repository }
    );

    expect(repository.listRecentByUser).toHaveBeenCalledWith({
      userId: "session-user",
      limit: 8,
    });
    expect(output.records[0]?.status).toBe("expired");
  });
});
