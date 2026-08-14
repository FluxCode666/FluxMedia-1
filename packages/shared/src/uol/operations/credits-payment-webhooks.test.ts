/**
 * 积分充值 webhook UOL operation 契约测试。
 *
 * 使用方：Vitest；保证已验签通知只能由匹配支付渠道的 webhook Principal 调用，
 * 且原始签名参数不会穿过统一接口层。
 */
import { describe, expect, it } from "vitest";

/** 设置测试连接占位后加载积分 operation 定义。 */
async function loadCreditOperations() {
  process.env.DATABASE_URL ||=
    "postgres://test:test@127.0.0.1:5432/gpt2image_test";
  return import("./credits");
}

describe("credits payment webhook operations", () => {
  it("Epay 履约只接受规范化的已验签成功通知", async () => {
    const { fulfillEpayTopUp } = await loadCreditOperations();
    const input = {
      type: "alipay",
      tradeNo: "gateway-1",
      outTradeNo: "order-1",
      name: "credits",
      money: "20.00",
      tradeStatus: "TRADE_SUCCESS",
      param: "signed-metadata",
    };

    expect(fulfillEpayTopUp.access).toEqual({
      kind: "webhook",
      provider: "epay",
    });
    expect(fulfillEpayTopUp.input.safeParse(input).success).toBe(true);
    expect(
      fulfillEpayTopUp.input.safeParse({
        ...input,
        raw: { sign: "secret" },
      }).success
    ).toBe(false);
    expect(
      fulfillEpayTopUp.input.safeParse({
        ...input,
        tradeStatus: "WAIT_BUYER_PAY",
      }).success
    ).toBe(false);
  });

  it("Creem 履约只接受最小化的已验签积分购买通知", async () => {
    const { fulfillCreemTopUp } = await loadCreditOperations();
    const input = {
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

    expect(fulfillCreemTopUp.access).toEqual({
      kind: "webhook",
      provider: "creem",
    });
    expect(fulfillCreemTopUp.input.safeParse(input).success).toBe(true);
    expect(
      fulfillCreemTopUp.input.safeParse({
        ...input,
        raw: { signature: "secret" },
      }).success
    ).toBe(false);
  });
});
