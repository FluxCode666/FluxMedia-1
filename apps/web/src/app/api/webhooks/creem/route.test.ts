/**
 * Creem webhook 薄适配路由测试。
 *
 * 使用方：Vitest；验证验签和事件过滤留在传输层，积分购买只以最小字段经 UOL 履约。
 */
import type {
  CreemCheckoutCompletedData,
  CreemWebhookEvent,
} from "@repo/shared/payment/creem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ||=
    "postgres://test:test@127.0.0.1:5432/gpt2image_test";
  return {
    constructRuntimeCreemEvent: vi.fn(),
    headers: vi.fn(),
    invokeOperation: vi.fn(),
    ensureUolInitialized: vi.fn(),
    loggerInfo: vi.fn(),
    logError: vi.fn(),
  };
});

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
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { info: mocks.loggerInfo },
  logError: mocks.logError,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { POST } from "./route";

/** 构造一条已验签的 Creem 积分购买事件。 */
function creditPurchaseEvent(): CreemWebhookEvent {
  return {
    id: "evt-credit",
    eventType: "checkout.completed",
    created_at: Date.parse("2026-08-13T03:30:00.000Z"),
    object: {
      id: "checkout-1",
      object: "checkout",
      request_id: "request-1",
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
      product: {
        id: "product-1",
        name: "Credits",
        price: 1999,
        currency: "USD",
        billing_type: "onetime",
        billing_period: "once",
      },
      status: "completed",
    } satisfies CreemCheckoutCompletedData,
  };
}

/** 构造已验签的退役订阅事件。 */
function subscriptionEvent(): CreemWebhookEvent {
  return {
    id: "evt-subscription",
    eventType: "subscription.active",
    created_at: Date.now(),
    object: {
      id: "sub-1",
      status: "active",
      product: "product-1",
      customer: "customer-1",
      current_period_start_date: "2026-08-01T00:00:00.000Z",
      current_period_end_date: "2026-09-01T00:00:00.000Z",
      cancel_at_period_end: false,
    },
  };
}

/** 创建 Creem webhook POST 请求。 */
function request(body = "signed-payload"): Request {
  return new Request("https://media.example.test/api/webhooks/creem", {
    method: "POST",
    body,
  });
}

describe("POST /api/webhooks/creem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue({ get: () => "valid-signature" });
    mocks.constructRuntimeCreemEvent.mockResolvedValue(creditPurchaseEvent());
    mocks.invokeOperation.mockResolvedValue({ processed: true });
  });

  it("积分购买只把最小规范化字段交给 Creem webhook operation", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.ensureUolInitialized).toHaveBeenCalledTimes(1);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "credits.fulfillCreemTopUp",
      {
        checkoutId: "checkout-1",
        requestId: "request-1",
        customerId: "customer-1",
        userId: "user-1",
        paymentOrderId: "order-1",
        packageId: "package-current",
        order: {
          id: "creem-order-1",
          amount: 1999,
          currency: "USD",
          productId: "product-1",
        },
        product: { id: "product-1", billingType: "onetime" },
        createdAt: Date.parse("2026-08-13T03:30:00.000Z"),
      },
      { type: "webhook", provider: "creem" }
    );
    const operationInput = mocks.invokeOperation.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(operationInput).not.toHaveProperty("email");
    expect(operationInput).not.toHaveProperty("signature");
  });

  it("订阅和非积分 Checkout 返回 2xx 且不初始化 UOL", async () => {
    mocks.constructRuntimeCreemEvent.mockResolvedValueOnce(subscriptionEvent());
    expect((await POST(request())).status).toBe(200);

    const event = creditPurchaseEvent();
    if (event.eventType === "checkout.completed") {
      (event.object as CreemCheckoutCompletedData).metadata = {
        type: "subscription",
      };
    }
    mocks.constructRuntimeCreemEvent.mockResolvedValueOnce(event);
    expect((await POST(request())).status).toBe(200);

    expect(mocks.ensureUolInitialized).not.toHaveBeenCalled();
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "creem" }),
      "Ignored retired subscription webhook"
    );
  });

  it("缺少或非法签名返回 400 且不调用 UOL", async () => {
    mocks.headers.mockResolvedValueOnce({ get: () => null });
    expect((await POST(request())).status).toBe(400);

    mocks.constructRuntimeCreemEvent.mockRejectedValueOnce(
      new Error("Invalid webhook signature")
    );
    expect((await POST(request())).status).toBe(400);

    expect(mocks.ensureUolInitialized).not.toHaveBeenCalled();
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("UOL 履约失败返回 500 触发 Creem 重投", async () => {
    mocks.invokeOperation.mockRejectedValueOnce(new Error("fulfill failed"));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), {
      source: "creem-webhook",
      stage: "handler",
    });
  });
});
