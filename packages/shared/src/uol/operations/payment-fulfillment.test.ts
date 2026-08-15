/**
 * 支付履约恢复 UOL 契约测试。
 *
 * 使用方：Vitest；锁定任务只能由指定 cron Principal 调用，且不向 Agent 暴露。
 */
import { describe, expect, it } from "vitest";

import { recoverPaymentFulfillments } from "./payment-fulfillment";

describe("payment fulfillment operation", () => {
  it("只接受 payment-fulfillment cron job 并声明财务维护副作用", () => {
    expect(recoverPaymentFulfillments.access).toEqual({
      kind: "cronJob",
      job: "payment-fulfillment",
    });
    expect(recoverPaymentFulfillments.agentExposure).toBe("human-only");
    expect(recoverPaymentFulfillments.hasMaintenanceWrite).toBe(true);
    expect(recoverPaymentFulfillments.sideEffects).toEqual([
      "billing",
      "audit",
    ]);
  });

  it("输入严格为空且输出统计不接受负数", () => {
    expect(recoverPaymentFulfillments.input.safeParse({}).success).toBe(true);
    expect(
      recoverPaymentFulfillments.input.safeParse({ batchSize: 100 }).success
    ).toBe(false);
    expect(
      recoverPaymentFulfillments.output.safeParse({
        expiredEventCount: 0,
        claimedCount: 1,
        succeededCount: 1,
        retryCount: 0,
        failedCount: 0,
        supersededCount: 0,
      }).success
    ).toBe(true);
    expect(
      recoverPaymentFulfillments.output.safeParse({
        expiredEventCount: 0,
        claimedCount: -1,
        succeededCount: 0,
        retryCount: 0,
        failedCount: 0,
        supersededCount: 0,
      }).success
    ).toBe(false);
  });
});
