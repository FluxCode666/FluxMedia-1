/**
 * Adobe 凭据通知设置 binding 测试。
 *
 * 职责：验证专用 operation 的真实超管边界、UOL 初始化后的委托参数、错误映射和
 * 输出脱敏。服务层由内存桩替代，不访问数据库、DNS 或邮件供应商。
 */
import "@repo/shared/uol/operations";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://unit-test:unit-test@127.0.0.1:5432/unit-test";
});

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const MockNotificationSettingsError = vi.hoisted(
  () =>
    class MockNotificationSettingsError extends Error {
      constructor(
        readonly code: "validation_error" | "internal_error",
        message: string
      ) {
        super(message);
      }
    }
);

vi.mock(
  "@/features/system-settings/adobe-credential-notification-settings-service",
  () => ({
    AdobeCredentialNotificationSettingsError: MockNotificationSettingsError,
    getAdobeCredentialNotificationSettings: mocks.get,
    setAdobeCredentialNotificationSettings: mocks.set,
  })
);

import "./notification-settings-binding";

const SETTINGS = {
  emailRecipients: ["ops@example.com"],
  emailConfigured: true,
  webhookHost: "hooks.example.com",
  webhookConfigured: true,
  webhookHmacConfigured: true,
  deliveryStatus: {
    email: {
      pending: 0,
      retrying: 0,
      failed: 0,
      lastDeliveredAt: "2026-08-04T00:00:00.000Z",
    },
    webhook: {
      pending: 1,
      retrying: 0,
      failed: 0,
      lastDeliveredAt: null,
    },
  },
};

describe("Adobe 凭据通知设置 binding", () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue(SETTINGS);
    mocks.set.mockReset().mockResolvedValue(SETTINGS);
  });

  it("仅 super_admin 可读取配置状态且不返回 URL 路径或 HMAC", async () => {
    await expect(
      invokeOperation(
        "settings.getAdobeCredentialNotifications",
        {},
        { type: "user", userId: "super-1", role: "super_admin" }
      )
    ).resolves.toEqual(SETTINGS);
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(JSON.stringify(SETTINGS)).not.toMatch(
      /https?:|secret|fingerprint|token|cookie/i
    );

    await expect(
      invokeOperation(
        "settings.getAdobeCredentialNotifications",
        {},
        { type: "user", userId: "admin-1", role: "admin" }
      )
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("写入使用真实超管 ID，错误映射为安全 validation_error", async () => {
    const input = {
      emailRecipients: ["ops@example.com"],
      webhookUrl: "https://hooks.example.com/adobe",
    };
    await expect(
      invokeOperation("settings.setAdobeCredentialNotifications", input, {
        type: "user",
        userId: "super-1",
        role: "super_admin",
      })
    ).resolves.toEqual(SETTINGS);
    expect(mocks.set).toHaveBeenCalledWith(input, "super-1");

    mocks.set.mockRejectedValueOnce(
      new MockNotificationSettingsError("validation_error", "Webhook 无效")
    );
    await expect(
      invokeOperation("settings.setAdobeCredentialNotifications", input, {
        type: "user",
        userId: "super-1",
        role: "super_admin",
      })
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("未知数据库或 DNS 错误由 UOL 脱敏且不暴露完整 Webhook", async () => {
    mocks.get.mockRejectedValueOnce(
      new Error("lookup https://hooks.example.com/adobe failed")
    );

    await expect(
      invokeOperation(
        "settings.getAdobeCredentialNotifications",
        {},
        { type: "user", userId: "super-1", role: "super_admin" }
      )
    ).rejects.toMatchObject({
      code: "internal_error",
      message: "An unexpected error occurred",
    });
  });

  it.each([
    {
      type: "user" as const,
      userId: "observer-1",
      role: "observer_admin" as const,
    },
    { type: "system" as const, reason: "test" },
    { type: "cron" as const, job: "adobe-credential-health" },
    {
      type: "apiKey" as const,
      credentialKind: "external" as const,
      userId: "user-1",
      apiKeyId: "key-1",
    },
  ])("拒绝非 super_admin Principal", async (principal) => {
    await expect(
      invokeOperation(
        "settings.setAdobeCredentialNotifications",
        { emailRecipients: [] },
        principal
      )
    ).rejects.toBeInstanceOf(OperationError);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
