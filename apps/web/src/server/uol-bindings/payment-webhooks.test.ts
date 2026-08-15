/**
 * 支付 webhook UOL binding 的 DB-free 测试。
 *
 * 使用方：Vitest；通过真实 invoke 网关验证 provider 权限、输入校验和 Epay 服务适配。
 */
import "@repo/shared/uol/operations";
import { invokeOperation } from "@repo/shared/uol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ||=
    "postgres://test:test@127.0.0.1:5432/gpt2image_test";
  return {
    fulfillSuccessfulEpayPayment: vi.fn(),
    fulfillSuccessfulCreemPayment: vi.fn(),
  };
});

vi.mock("@/features/payment/epay-fulfillment", () => ({
  fulfillSuccessfulEpayPayment: mocks.fulfillSuccessfulEpayPayment,
}));
vi.mock("@/features/payment/creem-fulfillment", () => ({
  fulfillSuccessfulCreemPayment: mocks.fulfillSuccessfulCreemPayment,
}));

import "./payment-webhooks";

const input = {
  type: "alipay",
  tradeNo: "gateway-1",
  outTradeNo: "order-1",
  name: "credits",
  money: "20.00",
  tradeStatus: "TRADE_SUCCESS",
  param: "signed-metadata",
};

const creemInput = {
  checkoutId: "checkout-1",
  requestId: "request-1",
  customerId: "customer-1",
  userId: "user-1",
  paymentOrderId: "payment-order-1",
  packageId: "package-1",
  order: {
    id: "creem-order-1",
    amount: 1999,
    currency: "USD",
    productId: "product-1",
  },
  product: { id: "product-1", billingType: "onetime" },
  createdAt: Date.parse("2026-08-13T03:30:00.000Z"),
};

describe("payment webhook bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fulfillSuccessfulEpayPayment.mockResolvedValue({
      metadata: {
        type: "credit_purchase",
        userId: "user-1",
        outTradeNo: "order-1",
      },
    });
    mocks.fulfillSuccessfulCreemPayment.mockResolvedValue(undefined);
  });

  it("Creem operation 只把规范化通知交给履约服务", async () => {
    await expect(
      invokeOperation("credits.fulfillCreemTopUp", creemInput, {
        type: "webhook",
        provider: "creem",
      })
    ).resolves.toEqual({ processed: true });

    expect(mocks.fulfillSuccessfulCreemPayment).toHaveBeenCalledWith(
      creemInput
    );

    await expect(
      invokeOperation("credits.fulfillCreemTopUp", creemInput, {
        type: "webhook",
        provider: "epay",
      })
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("Epay operation 重建可信 verify result 并调用现有履约服务", async () => {
    await expect(
      invokeOperation("credits.fulfillEpayTopUp", input, {
        type: "webhook",
        provider: "epay",
      })
    ).resolves.toEqual({ metadataType: "credit_purchase" });

    expect(mocks.fulfillSuccessfulEpayPayment).toHaveBeenCalledWith(
      {
        ...input,
        verifyStatus: true,
        raw: {},
      },
      "epay-webhook"
    );
  });

  it("错误 provider 与额外原始字段在服务调用前被拒绝", async () => {
    await expect(
      invokeOperation("credits.fulfillEpayTopUp", input, {
        type: "webhook",
        provider: "creem",
      })
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      invokeOperation(
        "credits.fulfillEpayTopUp",
        { ...input, raw: { sign: "secret" } },
        { type: "webhook", provider: "epay" }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.fulfillSuccessfulEpayPayment).not.toHaveBeenCalled();
  });
});
