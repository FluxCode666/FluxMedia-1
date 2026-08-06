/**
 * 积分包支付订单状态映射测试。
 *
 * 使用方：统一支付结果页。该测试锁定“服务端履约完成前绝不展示积分到账”的
 * 交互不变量；模块其余函数依赖数据库，故这里以最小 mock 保持 DB-free。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/database/schema", () => ({ paymentOrder: {} }));

import { getCreditPaymentDisplayStatus } from "./purchase-orders";

/** 固定时间下读取支付状态，避免测试依赖实际时钟。 */
function getStatus(status: string, expiresAt: Date | null) {
  return getCreditPaymentDisplayStatus({
    status,
    expiresAt,
    now: new Date("2026-07-20T00:00:00.000Z"),
  });
}

describe("getCreditPaymentDisplayStatus", () => {
  it("只有订单 fulfilled 后才展示积分已到账", () => {
    expect(getStatus("fulfilling", null)).toBe("payment_confirmed");
    expect(getStatus("fulfilled", null)).toBe("fulfilled");
  });

  it("对失败与未支付订单给出可重试的终态", () => {
    expect(getStatus("failed", null)).toBe("failed");
    expect(getStatus("pending", new Date("2026-07-19T23:59:59.000Z"))).toBe(
      "expired"
    );
  });

  it("等待中的订单在未到期时保持等待支付", () => {
    expect(getStatus("creating", null)).toBe("waiting_payment");
    expect(getStatus("pending", new Date("2026-07-20T00:30:00.000Z"))).toBe(
      "waiting_payment"
    );
  });
});
