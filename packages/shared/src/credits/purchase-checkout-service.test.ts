/**
 * 积分包购买 Checkout 领域服务测试。
 *
 * 使用方：Vitest。通过内存依赖验证报价冻结、用户幂等重放、支付网关分支和
 * 失败回写，不加载数据库连接或真实第三方 SDK。
 */

import { describe, expect, it, vi } from "vitest";

import type { RuntimeCreditPackage } from "./packages";
import {
  type CreditPackagePurchaseCheckoutDependencies,
  CreditPackagePurchaseCheckoutError,
  createCreditPackagePurchaseCheckout,
} from "./purchase-checkout-service";
import type { CreditPackagePaymentOrder } from "./purchase-orders";

const fixedNow = new Date("2026-08-15T08:00:00.000Z");

const visiblePackage = {
  id: "starter",
  name: "Starter",
  credits: 5_000,
  price: 20,
  currency: "CNY",
  description: "Starter credits",
  visible: true,
  allowQuantity: true,
  maxQuantity: 5,
  creemProductId: "creem-starter",
} satisfies RuntimeCreditPackage;

const creatingOrder = {
  id: "order-1",
  userId: "user-1",
  provider: "epay",
  status: "creating",
  currency: "CNY",
  amount: 40,
  amountMinor: 4_000,
  creditsAmount: 10_000,
  expiresAt: new Date("2026-08-15T08:30:00.000Z"),
  fulfilledAt: null,
  providerPayload: null,
  providerTradeNo: null,
} satisfies CreditPackagePaymentOrder;

/** 构造完全内存化的生产依赖替身，并允许单项覆盖测试分支。 */
function createDependencies(
  overrides: Partial<CreditPackagePurchaseCheckoutDependencies> = {}
) {
  const createPaymentOrder = vi.fn(async () => creatingOrder);
  const saveEpayOrder = vi.fn(async () => undefined);
  const saveProviderReference = vi.fn(async () => undefined);
  const createEpayPurchase = vi.fn(async () => ({
    url: "https://pay.example.test/submit",
    params: { sign: "signed" },
  }));
  const createCreemCheckout = vi.fn(async () => ({
    id: "checkout-1",
    checkout_url: "https://checkout.example.test/session",
  }));
  const saveCheckout = vi.fn(async () => undefined);
  const failCheckout = vi.fn(async () => undefined);
  const dependencies: CreditPackagePurchaseCheckoutDependencies = {
    getPackageById: async () => visiblePackage,
    isPackageVisible: () => true,
    getPackagePrice: (pkg) => pkg.price,
    getPackageCurrency: (pkg) => pkg.currency ?? "CNY",
    getPackageCreemProductId: (pkg) => pkg.creemProductId ?? pkg.id,
    getPaymentProvider: async () => "epay",
    assertCreemConfigured: async () => undefined,
    getBaseUrl: () => "https://flux.example.test",
    getCreditsExpiryDays: async () => 30,
    getCurrencyMinorUnitExponent: () => 2,
    createPaymentOrder,
    saveEpayOrder,
    saveProviderReference,
    createEpayPurchase,
    createCreemCheckout,
    saveCheckout,
    failCheckout,
    getCheckoutUrl: (payload) => {
      const value = payload?.checkoutUrl;
      return typeof value === "string" ? value : null;
    },
    logCheckoutStarted: vi.fn(),
    now: () => fixedNow,
    ...overrides,
  };
  return {
    dependencies,
    spies: {
      createPaymentOrder,
      saveEpayOrder,
      saveProviderReference,
      createEpayPurchase,
      createCreemCheckout,
      saveCheckout,
      failCheckout,
    },
  };
}

/** 使用固定的用户幂等输入调用领域服务。 */
function createCheckout(
  dependencies: CreditPackagePurchaseCheckoutDependencies,
  quantity?: number
) {
  return createCreditPackagePurchaseCheckout(
    {
      userId: "user-1",
      packageId: "starter",
      clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462",
      locale: "zh",
      ...(quantity !== undefined ? { quantity } : {}),
    },
    dependencies
  );
}

describe("createCreditPackagePurchaseCheckout", () => {
  it("按数量冻结易支付报价并返回 POST 表单", async () => {
    const { dependencies, spies } = createDependencies();

    await expect(createCheckout(dependencies, 2)).resolves.toEqual({
      url: "https://pay.example.test/submit",
      params: { sign: "signed" },
      method: "POST",
      orderId: "order-1",
    });
    expect(spies.createPaymentOrder).toHaveBeenCalledWith({
      userId: "user-1",
      clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462",
      provider: "epay",
      currency: "CNY",
      amount: 40,
      amountMinor: 4_000,
      creditsAmount: 10_000,
      pricingSnapshot: {
        packageId: "starter",
        quantity: 2,
        currency: "CNY",
        amountMinor: 4_000,
        creditsAmount: 10_000,
        creditsExpiresAt: "2026-09-14T08:00:00.000Z",
      },
      expiresAt: new Date("2026-08-15T08:30:00.000Z"),
    });
    expect(spies.createEpayPurchase).toHaveBeenCalledWith({
      outTradeNo: "CRorder1",
      name: "FluxMedia Credits 5000 x 2",
      money: 40,
    });
    expect(spies.saveCheckout).toHaveBeenCalledWith({
      orderId: "order-1",
      provider: "epay",
      providerPayload: { outTradeNo: "CRorder1" },
      expiresAt: new Date("2026-08-15T08:30:00.000Z"),
    });
  });

  it("已履约的幂等订单直接返回本地结果页且不重复外呼", async () => {
    const { dependencies, spies } = createDependencies({
      createPaymentOrder: async () => ({
        ...creatingOrder,
        status: "fulfilled",
      }),
    });

    await expect(createCheckout(dependencies, 2)).resolves.toEqual({
      url: "https://flux.example.test/zh/dashboard/credits/payment/order-1",
      orderId: "order-1",
    });
    expect(spies.createEpayPurchase).not.toHaveBeenCalled();
    expect(spies.createCreemCheckout).not.toHaveBeenCalled();
  });

  it("Creem 幂等订单已有 Checkout URL 时直接重放", async () => {
    const { dependencies, spies } = createDependencies({
      getPaymentProvider: async () => "creem",
      createPaymentOrder: async () => ({
        ...creatingOrder,
        provider: "creem",
        amount: 20,
        amountMinor: 2_000,
        creditsAmount: 5_000,
        providerPayload: {
          checkoutUrl: "https://checkout.example.test/existing",
        },
      }),
    });

    await expect(createCheckout(dependencies)).resolves.toEqual({
      url: "https://checkout.example.test/existing",
      orderId: "order-1",
    });
    expect(spies.createCreemCheckout).not.toHaveBeenCalled();
  });

  it("第三方创建失败时先终结本地 creating 订单再上抛", async () => {
    const upstreamError = new Error("epay unavailable");
    const { dependencies, spies } = createDependencies({
      createEpayPurchase: async () => {
        throw upstreamError;
      },
    });

    await expect(createCheckout(dependencies)).rejects.toBe(upstreamError);
    expect(spies.failCheckout).toHaveBeenCalledWith({
      orderId: "order-1",
      provider: "epay",
    });
  });

  it("把关闭支付和订单幂等冲突作为安全领域错误返回", async () => {
    const disabled = createDependencies({
      getPaymentProvider: async () => "none",
    });
    await expect(createCheckout(disabled.dependencies)).rejects.toMatchObject({
      code: "payment_disabled",
      message: "支付功能当前未启用",
    });

    const conflict = createDependencies({
      createPaymentOrder: async () => {
        throw new Error("该支付请求已用于另一份积分包");
      },
    });
    await expect(createCheckout(conflict.dependencies)).rejects.toEqual(
      new CreditPackagePurchaseCheckoutError(
        "idempotency_conflict",
        "该支付请求已用于另一份积分包"
      )
    );
  });

  it("只转换明确的 Creem 缺配置错误且不吞配置读取故障", async () => {
    const missingConfig = createDependencies({
      getPaymentProvider: async () => "creem",
      assertCreemConfigured: async () => {
        throw new Error("Creem 支付通道未完整配置，请在系统设置中填写");
      },
    });
    await expect(
      createCheckout(missingConfig.dependencies)
    ).rejects.toMatchObject({
      code: "provider_not_configured",
      message:
        "Creem 支付通道未完整配置，请联系管理员填写 API Key 和 Webhook Secret",
    });

    const settingsFailure = new Error("settings database unavailable");
    const unavailable = createDependencies({
      getPaymentProvider: async () => "creem",
      assertCreemConfigured: async () => {
        throw settingsFailure;
      },
    });
    await expect(createCheckout(unavailable.dependencies)).rejects.toBe(
      settingsFailure
    );
  });
});
