/**
 * Adobe 凭据通知 Server Action 薄适配测试。
 *
 * 职责：验证 Action 先初始化 UOL，再从真实超管上下文构造 Principal；不加载数据库、
 * DNS 或通知供应商，且不为浏览器提供 HMAC 或完整 Webhook URL。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@repo/shared/safe-action", () => {
  type Handler = (input: {
    parsedInput: unknown;
    ctx: { userId: string; role: "admin" | "super_admin" };
  }) => Promise<unknown>;
  const createBuilder = () => {
    const builder = {
      metadata: () => builder,
      schema: () => builder,
      action: (handler: Handler) => handler,
    };
    return builder;
  };
  return {
    ActionUserError: class ActionUserError extends Error {},
    superAdminAction: createBuilder(),
  };
});
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invoke,
  OperationError: class OperationError extends Error {
    code = "internal_error";
  },
}));
vi.mock("@/server/uol-init", () => ({ ensureUolInitialized: mocks.ensure }));

import {
  getAdobeCredentialNotificationSettingsAction,
  setAdobeCredentialNotificationSettingsAction,
} from "./adobe-credential-notification-actions";

type MockAction = (input: {
  parsedInput: unknown;
  ctx: { userId: string; role: "admin" | "super_admin" };
}) => Promise<unknown>;

const SETTINGS = {
  emailRecipients: ["ops@example.com"],
  emailConfigured: true,
  webhookHost: "hooks.example.com",
  webhookConfigured: false,
  webhookHmacConfigured: false,
  deliveryStatus: {
    email: {
      pending: 0,
      retrying: 0,
      failed: 0,
      lastDeliveredAt: null,
    },
    webhook: {
      pending: 0,
      retrying: 0,
      failed: 1,
      lastDeliveredAt: null,
    },
  },
};

describe("Adobe 凭据通知 Server Action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensure.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue(SETTINGS);
  });

  it("读取动作先初始化 UOL，并使用超管 Principal", async () => {
    await expect(
      (getAdobeCredentialNotificationSettingsAction as unknown as MockAction)({
        parsedInput: {},
        ctx: { userId: "super-1", role: "super_admin" },
      })
    ).resolves.toBe(SETTINGS);
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "settings.getAdobeCredentialNotifications",
      {},
      { type: "user", userId: "super-1", role: "super_admin" }
    );
  });

  it("写入动作传递增量字段，不携带密钥并初始化 UOL", async () => {
    const input = {
      emailRecipients: ["ops@example.com"],
      webhookUrl: "",
    };
    await expect(
      (setAdobeCredentialNotificationSettingsAction as unknown as MockAction)({
        parsedInput: input,
        ctx: { userId: "super-1", role: "super_admin" },
      })
    ).resolves.toBe(SETTINGS);
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "settings.setAdobeCredentialNotifications",
      input,
      { type: "user", userId: "super-1", role: "super_admin" }
    );
    expect(JSON.stringify(input)).not.toMatch(/hmac|secret|token/i);
  });
});
