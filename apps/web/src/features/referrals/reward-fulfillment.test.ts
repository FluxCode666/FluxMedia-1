/** 推广首充 UOL 薄适配器 DB-free 契约测试。 */
import { describe, expect, it, vi } from "vitest";
import { invokeReferralFirstPayment } from "./reward-fulfillment";

describe("invokeReferralFirstPayment", () => {
  it("uses the provider-scoped operation and webhook principal", async () => {
    const initialize = vi.fn(async () => undefined);
    const invoke = vi.fn(async () => ({ rewarded: true }));
    await invokeReferralFirstPayment(
      {
        provider: "alipay",
        orderId: "order-1",
        inviteeUserId: "user-1",
        firstPaymentCredits: 100,
      },
      { initialize, invoke }
    );
    expect(initialize).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      "referral.fulfillFirstPayment.alipay",
      {
        orderId: "order-1",
        inviteeUserId: "user-1",
        firstPaymentCredits: 100,
      },
      { type: "webhook", provider: "alipay" }
    );
  });
});
