/**
 * Creem Webhook 订阅退役回归测试。
 *
 * 历史订阅事件必须在签名验证后稳定返回 2xx，且不查询或更新数据库、不发放积分。
 * 非法签名仍应在 ignored 分支之前被拒绝，防止伪造请求伪装成已退役事件。
 */
import type { CreemWebhookEvent } from "@repo/shared/payment/creem";
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
  creditsBatch: {},
  user: {},
}));
vi.mock("@repo/shared/credits/core", () => ({
  grantCredits: mocks.grantCredits,
}));
vi.mock("@/features/referrals/reward-fulfillment", () => ({
  invokeReferralFirstPayment: vi.fn(),
}));
vi.mock("@repo/shared/credits/purchase-orders", () => ({
  claimCreditPackagePaymentOrderForFulfillment: vi.fn(),
  failCreditPackagePaymentOrder: vi.fn(),
  fulfillCreditPackagePaymentOrder: vi.fn(),
  releaseCreditPackagePaymentOrderFulfillment: vi.fn(),
}));
vi.mock("@repo/shared/credits/packages", () => ({
  getCreditPackageCurrency: vi.fn(),
  getRuntimeCreditPackageById: vi.fn(),
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
    mocks.headers.mockResolvedValue({ get: () => "valid-signature" });
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
});
