/**
 * Creem Webhook 订阅退役与冻结支付快照回归测试。
 *
 * 历史订阅事件必须在签名验证后稳定返回 2xx，且不查询或更新数据库、不发放积分。
 * 非法签名仍应在 ignored 分支之前被拒绝，防止伪造请求伪装成已退役事件。
 */
import type {
  CreemCheckoutCompletedData,
  CreemWebhookEvent,
} from "@repo/shared/payment/creem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructRuntimeCreemEvent: vi.fn(),
  headers: vi.fn(),
  loggerInfo: vi.fn(),
  logError: vi.fn(),
  logEvent: vi.fn(),
  grantCredits: vi.fn(),
  dbUpdate: vi.fn(),
  dbSelect: vi.fn(),
  dbInsert: vi.fn(),
  confirmPayment: vi.fn(),
  rejectAmountMismatch: vi.fn(),
  processFulfillment: vi.fn(),
  getRuntimeCreditPackageById: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: <T>(handler: T): T => handler,
}));
vi.mock("@repo/shared/payment/creem", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/shared/payment/creem")
  >("@repo/shared/payment/creem");
  return {
    ...actual,
    constructRuntimeCreemEvent: mocks.constructRuntimeCreemEvent,
  };
});
vi.mock("@repo/shared/logger", () => ({
  logger: { info: mocks.loggerInfo, error: vi.fn(), warn: vi.fn() },
  logError: mocks.logError,
  logEvent: mocks.logEvent,
}));
vi.mock("@repo/database", () => ({
  db: {
    update: mocks.dbUpdate,
    select: mocks.dbSelect,
    insert: mocks.dbInsert,
  },
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
  user: {},
}));
vi.mock("@/features/payment/payment-lifecycle-service", () => ({
  confirmPaymentAndCreateFulfillmentWorkItem: mocks.confirmPayment,
  rejectCreemPaymentAmountMismatch: mocks.rejectAmountMismatch,
}));
vi.mock("@/features/payment/payment-fulfillment-service", () => ({
  processPaymentFulfillmentOrder: mocks.processFulfillment,
}));
vi.mock("@repo/shared/credits/packages", () => ({
  getCreditPackageCurrency: vi.fn(),
  getRuntimeCreditPackageById: mocks.getRuntimeCreditPackageById,
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingNumber: vi.fn(),
}));

import { POST } from "./route";

function subscriptionEvent(
  eventType: CreemWebhookEvent["eventType"]
): CreemWebhookEvent {
  return {
    id: `evt-${eventType}`,
    eventType,
    created_at: Date.now(),
    object: {
      id: "sub-1",
      status: "active",
      product: "prod-1",
      customer: "cus-1",
      current_period_start_date: "2026-01-01T00:00:00.000Z",
      current_period_end_date: "2026-02-01T00:00:00.000Z",
      cancel_at_period_end: false,
    },
  };
}

function request(body = "{}") {
  return new Request("https://media.example.test/api/webhooks/creem", {
    method: "POST",
    body,
  });
}

/** 构造一条带本地订单 ID 的 Creem 积分包成功通知。 */
function creditPurchaseEvent(): CreemWebhookEvent {
  return {
    id: "evt-credit",
    eventType: "checkout.completed",
    created_at: Date.now(),
    object: {
      id: "checkout-1",
      object: "checkout",
      customer: {
        id: "customer-1",
        email: "user@example.test",
      },
      metadata: {
        type: "credit_purchase",
        userId: "user-1",
        paymentOrderId: "order-1",
        packageId: "package-current",
      },
      order: {
        object: "order",
        id: "creem-order-1",
        customer: "customer-1",
        product: "product-1",
        amount: 1999,
        currency: "USD",
        status: "paid",
        type: "onetime",
      },
      status: "completed",
    } satisfies CreemCheckoutCompletedData,
  };
}

/** 把 db.select 链配置为返回订单创建时冻结的旧报价。 */
function mockFrozenPaymentOrder(input: { legacy?: boolean } = {}) {
  const pricingSnapshot: Record<string, unknown> = {
    packageId: "package-original",
    quantity: 1,
    currency: "USD",
    amountMinor: 1999,
    creditsAmount: 250,
  };
  if (!input.legacy) pricingSnapshot.creditsExpiresAt = null;
  const limit = vi.fn().mockResolvedValue([
    {
      id: "order-1",
      userId: "user-1",
      provider: "creem",
      purpose: "credit_package",
      currency: "USD",
      amountMinor: 1999,
      creditsAmount: 250,
      pricingSnapshot,
    },
  ]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mocks.dbSelect.mockReturnValue({ from });
}

describe("POST /api/webhooks/creem", () => {
  beforeEach(() => {
    mocks.constructRuntimeCreemEvent.mockReset();
    mocks.headers.mockReset();
    mocks.loggerInfo.mockReset();
    mocks.logError.mockReset();
    mocks.logEvent.mockReset();
    mocks.grantCredits.mockReset();
    mocks.dbUpdate.mockReset();
    mocks.dbSelect.mockReset();
    mocks.dbInsert.mockReset();
    mocks.confirmPayment.mockReset();
    mocks.rejectAmountMismatch.mockReset();
    mocks.processFulfillment.mockReset();
    mocks.getRuntimeCreditPackageById.mockReset();
    mocks.headers.mockResolvedValue({ get: () => "valid-signature" });
    mocks.dbUpdate.mockReturnValue({
      set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    });
  });

  it.each([
    "subscription.active",
    "subscription.renewed",
    "subscription.paid",
    "subscription.canceled",
    "subscription.past_due",
    "subscription.paused",
    "subscription.expired",
  ])("已验签的 %s 事件返回 2xx 且无任何履约副作用", async (eventType) => {
    mocks.constructRuntimeCreemEvent.mockResolvedValue(
      subscriptionEvent(eventType as CreemWebhookEvent["eventType"])
    );

    const response = await POST(request("signed-payload"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(mocks.dbSelect).not.toHaveBeenCalled();
    expect(mocks.dbInsert).not.toHaveBeenCalled();
    expect(mocks.grantCredits).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "creem",
        eventType,
        eventId: `evt-${eventType}`,
      }),
      "Ignored retired subscription webhook"
    );
    const loggedPayload = mocks.loggerInfo.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(loggedPayload).not.toHaveProperty("payload");
    expect(loggedPayload).not.toHaveProperty("signature");
  });

  it("合法但非积分充值的 checkout.completed 事件同样被忽略", async () => {
    mocks.constructRuntimeCreemEvent.mockResolvedValue({
      id: "evt-checkout",
      eventType: "checkout.completed",
      created_at: Date.now(),
      object: {
        id: "checkout-1",
        object: "checkout",
        customer: { id: "cus-1", email: "user@example.test" },
        metadata: { type: "subscription" },
        status: "completed",
      },
    } satisfies CreemWebhookEvent);

    const response = await POST(request("signed-payload"));

    expect(response.status).toBe(200);
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("非法签名返回 400 且不进入 ignored 分支", async () => {
    mocks.headers.mockResolvedValue({ get: () => "invalid-signature" });
    mocks.constructRuntimeCreemEvent.mockRejectedValue(
      new Error("Invalid webhook signature")
    );

    const response = await POST(request("forged-payload"));

    expect(response.status).toBe(400);
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("管理员修改积分包后旧支付仍按订单冻结快照履约", async () => {
    const event = creditPurchaseEvent();
    event.created_at = Date.parse("2026-08-13T03:30:00.000Z");
    mocks.constructRuntimeCreemEvent.mockResolvedValue(event);
    mockFrozenPaymentOrder();
    mocks.getRuntimeCreditPackageById.mockResolvedValue({
      id: "package-original",
      credits: 999,
      price: 99.99,
      currency: "EUR",
    });
    mocks.confirmPayment.mockResolvedValue("created");
    mocks.processFulfillment.mockResolvedValue({ status: "succeeded" });

    const response = await POST(request("signed-payload"));

    expect(response.status).toBe(200);
    expect(mocks.getRuntimeCreditPackageById).not.toHaveBeenCalled();
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
            reportedPackageId: "package-current",
            amountMinor: 1999,
            currency: "USD",
          }),
        }),
      })
    );
    expect(mocks.processFulfillment).toHaveBeenCalledWith("order-1");
  });

  it("旧订单缺少 creditsExpiresAt 时仍可按冻结金额和积分履约", async () => {
    const event = creditPurchaseEvent();
    event.created_at = Date.parse("2026-08-13T03:30:00.000Z");
    mocks.constructRuntimeCreemEvent.mockResolvedValue(event);
    mockFrozenPaymentOrder({ legacy: true });
    mocks.confirmPayment.mockResolvedValue("created");

    const response = await POST(request("signed-payload"));

    expect(response.status).toBe(200);
    expect(mocks.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        occurredAt: new Date("2026-08-13T03:30:00.000Z"),
        timestampSource: "provider",
      })
    );
  });

  it("金额硬拒时原子终结订单且不创建履约工作项", async () => {
    const previous = process.env.CREEM_WEBHOOK_ENFORCE_AMOUNT;
    process.env.CREEM_WEBHOOK_ENFORCE_AMOUNT = "true";
    try {
      const event = creditPurchaseEvent();
      if (event.eventType === "checkout.completed") {
        const checkout = event.object as CreemCheckoutCompletedData;
        if (checkout.order) checkout.order.amount = 1;
      }
      mocks.constructRuntimeCreemEvent.mockResolvedValue(event);
      mockFrozenPaymentOrder();
      mocks.rejectAmountMismatch.mockResolvedValue(true);

      const response = await POST(request("signed-payload"));

      expect(response.status).toBe(200);
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
});
