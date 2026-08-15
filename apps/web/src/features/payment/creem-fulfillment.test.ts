/**
 * Creem 已验签积分购买履约服务测试。
 *
 * 使用方：Vitest；覆盖冻结快照、历史通知幂等键、金额硬拒和持久工作项处理。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbUpdate: vi.fn(),
  dbSelect: vi.fn(),
  grantCredits: vi.fn(),
  getRuntimeCreditPackageById: vi.fn(),
  getCreditPackageCurrency: vi.fn(),
  getRuntimeSettingNumber: vi.fn(),
  confirmPayment: vi.fn(),
  rejectAmountMismatch: vi.fn(),
  processFulfillment: vi.fn(),
  invokeReferralFirstPayment: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  db: { update: mocks.dbUpdate, select: mocks.dbSelect },
}));
vi.mock("@repo/database/schema", () => ({
  paymentOrder: {
    id: "payment_order.id",
    userId: "payment_order.user_id",
    provider: "payment_order.provider",
    purpose: "payment_order.purpose",
    currency: "payment_order.currency",
    amountMinor: "payment_order.amount_minor",
    creditsAmount: "payment_order.credits_amount",
    pricingSnapshot: "payment_order.pricing_snapshot",
  },
  user: { id: "user.id" },
}));
vi.mock("@repo/shared/credits/core", () => ({
  grantCredits: mocks.grantCredits,
}));
vi.mock("@repo/shared/credits/packages", () => ({
  getRuntimeCreditPackageById: mocks.getRuntimeCreditPackageById,
  getCreditPackageCurrency: mocks.getCreditPackageCurrency,
}));
vi.mock("@repo/shared/credits/top-up", () => ({
  getCurrencyMinorUnitExponent: () => 2,
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: mocks.getRuntimeSettingNumber,
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: vi.fn(),
  logEvent: mocks.logEvent,
}));
vi.mock("@/features/payment/payment-lifecycle-service", () => ({
  confirmPaymentAndCreateFulfillmentWorkItem: mocks.confirmPayment,
  rejectCreemPaymentAmountMismatch: mocks.rejectAmountMismatch,
}));
vi.mock("@/features/payment/payment-fulfillment-service", () => ({
  processPaymentFulfillmentOrder: mocks.processFulfillment,
}));
vi.mock("@/features/referrals/reward-fulfillment", () => ({
  invokeReferralFirstPayment: mocks.invokeReferralFirstPayment,
}));

import {
  type CreemCreditPurchaseNotification,
  fulfillSuccessfulCreemPayment,
} from "./creem-fulfillment";

/** 构造 UOL 已校验的 Creem 积分购买通知。 */
function notification(
  overrides: Partial<CreemCreditPurchaseNotification> = {}
): CreemCreditPurchaseNotification {
  return {
    checkoutId: "checkout-1",
    requestId: "request-1",
    customerId: "customer-1",
    userId: "user-1",
    paymentOrderId: "order-1",
    packageId: "package-reported",
    order: {
      id: "creem-order-1",
      amount: 1999,
      currency: "USD",
      productId: "product-1",
    },
    product: { id: "product-1", billingType: "onetime" },
    createdAt: Date.parse("2026-08-13T03:30:00.000Z"),
    ...overrides,
  };
}

/** 把 payment_order 查询链配置为返回冻结订单。 */
function mockPaymentOrder(overrides: Record<string, unknown> = {}): void {
  const order = {
    id: "order-1",
    userId: "user-1",
    provider: "creem",
    purpose: "credit_package",
    currency: "USD",
    amountMinor: 1999,
    creditsAmount: 250,
    pricingSnapshot: {
      packageId: "package-original",
      quantity: 1,
      currency: "USD",
      amountMinor: 1999,
      creditsAmount: 250,
    },
    ...overrides,
  };
  const limit = vi.fn().mockResolvedValue([order]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mocks.dbSelect.mockReturnValue({ from });
}

describe("fulfillSuccessfulCreemPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbUpdate.mockReturnValue({
      set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    mocks.confirmPayment.mockResolvedValue("created");
    mocks.processFulfillment.mockResolvedValue({ status: "succeeded" });
    mocks.rejectAmountMismatch.mockResolvedValue(true);
  });

  it("按本地冻结快照确认支付并处理持久工作项", async () => {
    mockPaymentOrder();

    await fulfillSuccessfulCreemPayment(notification());

    expect(mocks.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-1",
        userId: "user-1",
        provider: "creem",
        providerTradeNo: "creem-order-1",
        eventSourceRef: "creem:creem-order-1",
        occurredAt: new Date("2026-08-13T03:30:00.000Z"),
        timestampSource: "provider",
        fulfillment: expect.objectContaining({
          creditsAmount: 250,
          creditSourceRef: "creem:order-1",
          metadata: expect.objectContaining({
            packageId: "package-original",
            reportedPackageId: "package-reported",
            amountMinor: 1999,
            currency: "USD",
          }),
        }),
      })
    );
    expect(mocks.processFulfillment).toHaveBeenCalledWith("order-1");
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "payment.checkout.completed",
      expect.objectContaining({ userId: "user-1" })
    );
  });

  it("已完成订单不重复处理工作项", async () => {
    mockPaymentOrder();
    mocks.confirmPayment.mockResolvedValue("fulfilled");

    await fulfillSuccessfulCreemPayment(notification());

    expect(mocks.processFulfillment).not.toHaveBeenCalled();
  });

  it("历史通知沿用旧积分和推广幂等身份", async () => {
    mocks.getRuntimeCreditPackageById.mockResolvedValue({
      id: "package-legacy",
      credits: 250,
      price: 19.99,
      currency: "USD",
    });
    mocks.getCreditPackageCurrency.mockReturnValue("USD");
    mocks.getRuntimeSettingNumber.mockResolvedValue(0);
    mocks.grantCredits.mockResolvedValue({ batchId: "batch-legacy" });

    const legacyNotification = notification({ packageId: "package-legacy" });
    delete legacyNotification.paymentOrderId;
    await fulfillSuccessfulCreemPayment(legacyNotification);
    await fulfillSuccessfulCreemPayment(legacyNotification);

    expect(mocks.dbSelect).not.toHaveBeenCalled();
    expect(mocks.grantCredits).toHaveBeenCalledTimes(2);
    expect(mocks.grantCredits).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: "user-1",
        amount: 250,
        sourceRef: "credit_purchase:creem-order-1",
        expiresAt: null,
      })
    );
    expect(mocks.grantCredits).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sourceRef: "credit_purchase:creem-order-1",
      })
    );
    expect(mocks.invokeReferralFirstPayment).toHaveBeenNthCalledWith(1, {
      orderId: "creem-order-1",
      inviteeUserId: "user-1",
      firstPaymentCredits: 250,
      provider: "creem",
    });
    expect(mocks.invokeReferralFirstPayment).toHaveBeenNthCalledWith(2, {
      orderId: "creem-order-1",
      inviteeUserId: "user-1",
      firstPaymentCredits: 250,
      provider: "creem",
    });
  });

  it("金额硬拒时终结订单且不创建履约工作项", async () => {
    const previous = process.env.CREEM_WEBHOOK_ENFORCE_AMOUNT;
    process.env.CREEM_WEBHOOK_ENFORCE_AMOUNT = "true";
    try {
      mockPaymentOrder();

      await fulfillSuccessfulCreemPayment(
        notification({
          order: {
            id: "creem-order-1",
            amount: 1,
            currency: "USD",
          },
        })
      );

      expect(mocks.rejectAmountMismatch).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "order-1",
          userId: "user-1",
          providerTradeNo: "creem-order-1",
        })
      );
      expect(mocks.confirmPayment).not.toHaveBeenCalled();
      expect(mocks.processFulfillment).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.CREEM_WEBHOOK_ENFORCE_AMOUNT;
      } else {
        process.env.CREEM_WEBHOOK_ENFORCE_AMOUNT = previous;
      }
    }
  });

  it("订单归属或冻结快照不一致时 fail closed", async () => {
    mockPaymentOrder({ userId: "user-2" });
    await expect(fulfillSuccessfulCreemPayment(notification())).rejects.toThrow(
      "Creem 通知用户与本地订单不匹配"
    );
    expect(mocks.confirmPayment).not.toHaveBeenCalled();

    mockPaymentOrder({
      pricingSnapshot: {
        packageId: "package-original",
        quantity: 1,
        currency: "USD",
        amountMinor: 1,
        creditsAmount: 250,
      },
    });
    await expect(fulfillSuccessfulCreemPayment(notification())).rejects.toThrow(
      "Creem 支付订单冻结快照不一致"
    );
    expect(mocks.confirmPayment).not.toHaveBeenCalled();
  });

  it("缺少 userId 时保持忽略语义且不访问数据库", async () => {
    const missingUserNotification = notification();
    delete missingUserNotification.userId;
    await expect(
      fulfillSuccessfulCreemPayment(missingUserNotification)
    ).resolves.toBeUndefined();

    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(mocks.dbSelect).not.toHaveBeenCalled();
    expect(mocks.confirmPayment).not.toHaveBeenCalled();
  });
});
