/**
 * 支付履约 worker 的 DB-free 行为测试。
 *
 * 使用方：验证持久工作项在崩溃恢复、租约接管和积分幂等冲突时不会双发或误完成。
 * 关键依赖：可注入仓储端口；测试不连接 PostgreSQL。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/database/schema", () => ({
  creditsBatch: {},
  epayOrder: {},
  paymentFulfillmentWorkItem: {},
  paymentLifecycleEvent: {},
  paymentOrder: {},
}));
vi.mock("@repo/shared/credits/core", () => ({ grantCredits: vi.fn() }));
vi.mock("@/features/referrals/reward-fulfillment", () => ({
  invokeReferralFirstPayment: vi.fn(),
}));

import {
  type ClaimedPaymentFulfillmentWorkItem,
  type PaymentFulfillmentProcessorDependencies,
  processClaimedPaymentFulfillment,
} from "./payment-fulfillment-service";

/** 构造一条已由短事务提交并带 fencing token 的最小工作项。 */
function createClaimedWorkItem(
  overrides: Partial<ClaimedPaymentFulfillmentWorkItem> = {}
): ClaimedPaymentFulfillmentWorkItem {
  return {
    id: "work-1",
    paymentOrderId: "order-1",
    userId: "user-1",
    provider: "alipay_f2f",
    providerTradeNo: "trade-1",
    creditSourceRef: "alipay:order-1",
    creditsAmount: 120,
    creditsExpiresAt: null,
    debitAccount: "ALIPAY:trade-1",
    description: "Alipay credit top-up: 120 credits",
    metadata: { provider: "alipay_f2f" },
    leaseToken: "lease-a",
    attemptCount: 1,
    ...overrides,
  };
}

/** 构造带可观测 mock 的 processor 依赖。 */
function createDependencies(
  overrides: Partial<PaymentFulfillmentProcessorDependencies> = {}
): PaymentFulfillmentProcessorDependencies {
  return {
    findCreditsBatch: vi.fn().mockResolvedValue(null),
    grantCredits: vi.fn().mockResolvedValue({ batchId: "batch-1" }),
    loadCreditsBatch: vi.fn().mockResolvedValue({
      id: "batch-1",
      userId: "user-1",
      amount: 120,
    }),
    renewLease: vi.fn().mockResolvedValue(true),
    fulfillReferral: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(true),
    scheduleRetry: vi.fn().mockResolvedValue(true),
    failTerminal: vi.fn().mockResolvedValue(true),
    now: () => new Date("2026-08-13T04:00:00.000Z"),
    ...overrides,
  };
}

describe("processClaimedPaymentFulfillment", () => {
  it("只在 claim 短事务提交后调用自带事务的 grantCredits", async () => {
    let claimTransactionOpen = true;
    const dependencies = createDependencies({
      grantCredits: vi.fn().mockImplementation(async () => {
        expect(claimTransactionOpen).toBe(false);
        return { batchId: "batch-1" };
      }),
    });
    const claimed = await Promise.resolve(createClaimedWorkItem()).then(
      (workItem) => {
        claimTransactionOpen = false;
        return workItem;
      }
    );

    const result = await processClaimedPaymentFulfillment(
      claimed,
      dependencies
    );

    expect(result).toEqual({ status: "succeeded", workItemId: "work-1" });
    expect(dependencies.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "work-1",
        leaseToken: "lease-a",
        creditsBatchId: "batch-1",
      })
    );
  });

  it("完成事件使用实际完成时刻而不是尝试开始时刻", async () => {
    const timestamps = [
      new Date("2026-08-13T04:00:00.000Z"),
      new Date("2026-08-13T04:00:01.000Z"),
      new Date("2026-08-13T04:00:02.000Z"),
      new Date("2026-08-13T04:00:03.000Z"),
    ];
    const now = vi.fn(() => {
      const value = timestamps.shift();
      if (!value) throw new Error("测试时钟调用次数超出预期");
      return value;
    });
    const dependencies = createDependencies({ now });

    await expect(
      processClaimedPaymentFulfillment(createClaimedWorkItem(), dependencies)
    ).resolves.toEqual({ status: "succeeded", workItemId: "work-1" });

    expect(dependencies.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        occurredAt: new Date("2026-08-13T04:00:03.000Z"),
      })
    );
    expect(now).toHaveBeenCalledTimes(4);
  });

  it("积分已发放但完成事务崩溃后，恢复只补订单状态而不再次发放", async () => {
    const grantCredits = vi.fn().mockResolvedValue({ batchId: "batch-1" });
    const firstAttempt = createDependencies({
      grantCredits,
      complete: vi.fn().mockRejectedValue(new Error("database restarted")),
    });

    await expect(
      processClaimedPaymentFulfillment(createClaimedWorkItem(), firstAttempt)
    ).resolves.toEqual({
      status: "retry_scheduled",
      workItemId: "work-1",
    });

    const recovery = createDependencies({
      grantCredits,
      findCreditsBatch: vi.fn().mockResolvedValue({
        id: "batch-1",
        userId: "user-1",
        amount: 120,
      }),
    });
    await expect(
      processClaimedPaymentFulfillment(
        createClaimedWorkItem({ leaseToken: "lease-b", attemptCount: 2 }),
        recovery
      )
    ).resolves.toEqual({ status: "succeeded", workItemId: "work-1" });

    expect(grantCredits).toHaveBeenCalledTimes(1);
  });

  it("旧租约在新 worker 接管后不能迟到完成订单", async () => {
    const dependencies = createDependencies({
      complete: vi.fn().mockResolvedValue(false),
      scheduleRetry: vi.fn().mockResolvedValue(false),
    });

    await expect(
      processClaimedPaymentFulfillment(createClaimedWorkItem(), dependencies)
    ).resolves.toEqual({ status: "superseded", workItemId: "work-1" });

    expect(dependencies.scheduleRetry).not.toHaveBeenCalled();
  });

  it("租约已失效时不会执行积分发放副作用", async () => {
    const dependencies = createDependencies({
      renewLease: vi.fn().mockResolvedValue(false),
    });

    await expect(
      processClaimedPaymentFulfillment(createClaimedWorkItem(), dependencies)
    ).resolves.toEqual({ status: "superseded", workItemId: "work-1" });

    expect(dependencies.grantCredits).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it("首充奖励临时失败时保留工作项重试，恢复后幂等补齐再完成订单", async () => {
    const firstAttempt = createDependencies({
      fulfillReferral: vi
        .fn()
        .mockRejectedValue(new Error("referral database unavailable")),
    });

    await expect(
      processClaimedPaymentFulfillment(createClaimedWorkItem(), firstAttempt)
    ).resolves.toEqual({
      status: "retry_scheduled",
      workItemId: "work-1",
    });
    expect(firstAttempt.complete).not.toHaveBeenCalled();

    const recovery = createDependencies({
      findCreditsBatch: vi.fn().mockResolvedValue({
        id: "batch-1",
        userId: "user-1",
        amount: 120,
      }),
    });
    await expect(
      processClaimedPaymentFulfillment(
        createClaimedWorkItem({ leaseToken: "lease-b", attemptCount: 2 }),
        recovery
      )
    ).resolves.toEqual({ status: "succeeded", workItemId: "work-1" });

    expect(recovery.fulfillReferral).toHaveBeenCalledTimes(1);
    expect(recovery.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      title: "用户不匹配",
      batch: { id: "batch-1", userId: "user-2", amount: 120 },
    },
    {
      title: "金额不匹配",
      batch: { id: "batch-1", userId: "user-1", amount: 119 },
    },
  ])("幂等积分批次$title时确定性失败并关闭履约", async ({ batch }) => {
    const dependencies = createDependencies({
      findCreditsBatch: vi.fn().mockResolvedValue(batch),
    });

    await expect(
      processClaimedPaymentFulfillment(createClaimedWorkItem(), dependencies)
    ).resolves.toEqual({
      status: "failed_terminal",
      workItemId: "work-1",
    });

    expect(dependencies.grantCredits).not.toHaveBeenCalled();
    expect(dependencies.failTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "work-1",
        leaseToken: "lease-a",
        errorCode: "credits_batch_mismatch",
      })
    );
  });

  it("临时发放错误使用封顶退避写回 retry 而不终结已支付订单", async () => {
    const dependencies = createDependencies({
      grantCredits: vi.fn().mockRejectedValue(new Error("temporary db error")),
    });

    await expect(
      processClaimedPaymentFulfillment(
        createClaimedWorkItem({ attemptCount: 8 }),
        dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      workItemId: "work-1",
    });

    expect(dependencies.scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "fulfillment_attempt_failed",
        nextAttemptAt: new Date("2026-08-13T04:30:00.000Z"),
      })
    );
    expect(dependencies.failTerminal).not.toHaveBeenCalled();
  });
});
