/**
 * Adobe 凭据通知设置服务测试。
 *
 * 职责：验证 URL 在事务前 fail-closed、收件人归一化、弱 HMAC 不启用 Webhook，
 * 以及成功写入后才失效系统设置缓存。数据库和 DNS 均使用内存桩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  execute: vi.fn(),
  invalidate: vi.fn(),
  getJson: vi.fn(),
  getString: vi.fn(),
  emailSnapshot: vi.fn(),
  assertPublic: vi.fn(),
  insertedValues: [] as unknown[],
}));

const transactionBuilder = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(async () => []) })),
  })),
  delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  insert: vi.fn(() => ({
    values: vi.fn((value: unknown) => {
      mocks.insertedValues.push(value);
      return {
        onConflictDoUpdate: vi.fn(async () => undefined),
      };
    }),
  })),
};

vi.mock("@repo/database", () => ({
  db: {
    execute: mocks.execute,
    transaction: mocks.transaction,
  },
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingJson: mocks.getJson,
  getRuntimeSettingString: mocks.getString,
  invalidateSystemSettingsCache: mocks.invalidate,
}));
vi.mock("@repo/shared/mail/client", () => ({
  getEmailConfigurationSnapshot: mocks.emailSnapshot,
}));
vi.mock("@/features/external-api/safe-image-fetch", () => ({
  SafeImageFetchError: class SafeImageFetchError extends Error {},
  assertPublicCallbackUrl: mocks.assertPublic,
}));

import {
  getAdobeCredentialNotificationSettings,
  normalizeAdobeCredentialEmailRecipients,
  setAdobeCredentialNotificationSettings,
} from "./adobe-credential-notification-settings-service";

describe("Adobe 凭据通知设置服务", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertedValues.length = 0;
    mocks.transaction.mockImplementation(
      async (
        work: (transaction: typeof transactionBuilder) => Promise<unknown>
      ) => work(transactionBuilder)
    );
    mocks.execute.mockResolvedValue([]);
    mocks.invalidate.mockResolvedValue(undefined);
    mocks.getJson.mockResolvedValue(["Ops@Example.com"]);
    mocks.getString.mockResolvedValue("https://hooks.example.com/adobe");
    mocks.emailSnapshot.mockResolvedValue({ configured: true });
    mocks.assertPublic.mockResolvedValue(
      new URL("https://hooks.example.com/adobe")
    );
  });

  it("收件人去重并归一化", () => {
    expect(
      normalizeAdobeCredentialEmailRecipients([
        " Ops@example.com ",
        "ops@example.com",
        "admin@example.com",
      ])
    ).toEqual(["ops@example.com", "admin@example.com"]);
  });

  it("公网 URL 校验失败时不打开写事务", async () => {
    mocks.assertPublic.mockRejectedValueOnce(new Error("private target"));

    await expect(
      setAdobeCredentialNotificationSettings(
        { webhookUrl: "https://private.example.com/hook" },
        "super-1"
      )
    ).rejects.toBeInstanceOf(Error);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("写事务成功后才失效缓存，审计只保留安全投影", async () => {
    await setAdobeCredentialNotificationSettings(
      {
        emailRecipients: ["Ops@example.com"],
        webhookUrl: "https://hooks.example.com/adobe",
      },
      "super-1"
    );

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    const audit = mocks.insertedValues.find(
      (value): value is Record<string, unknown> =>
        Boolean(value && typeof value === "object" && "action" in value)
    );
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toMatch(/https?:|secret|fingerprint/i);
  });

  it("弱 HMAC 时保持 Webhook 未配置且只返回主机状态", async () => {
    process.env.ADOBE_CREDENTIAL_WEBHOOK_HMAC_SECRET = "short";
    const output = await getAdobeCredentialNotificationSettings();

    expect(output.webhookHost).toBe("hooks.example.com");
    expect(output.webhookHmacConfigured).toBe(false);
    expect(output.webhookConfigured).toBe(false);
    expect(JSON.stringify(output)).not.toMatch(/https?:|short|secret/i);
    delete process.env.ADOBE_CREDENTIAL_WEBHOOK_HMAC_SECRET;
  });

  it("读取收件人失败时显式上抛数据库或缓存错误", async () => {
    mocks.getJson.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(getAdobeCredentialNotificationSettings()).rejects.toThrow(
      "database unavailable"
    );
  });

  it("投递聚合返回非法数据库结果时显式失败", async () => {
    mocks.execute.mockResolvedValueOnce([
      {
        channel: "email",
        pending: "invalid",
        retrying: 0,
        failed: 0,
        last_delivered_at: null,
      },
    ]);

    await expect(
      getAdobeCredentialNotificationSettings()
    ).rejects.toMatchObject({
      name: "AdobeCredentialNotificationSettingsError",
      code: "internal_error",
      message: "通知投递状态暂时不可用",
    });
  });

  it("投递聚合返回非法时间时不降级为无最近成功记录", async () => {
    mocks.execute.mockResolvedValueOnce([
      {
        channel: "email",
        pending: 0,
        retrying: 0,
        failed: 0,
        last_delivered_at: "invalid",
      },
    ]);

    await expect(
      getAdobeCredentialNotificationSettings()
    ).rejects.toMatchObject({
      code: "internal_error",
      message: "通知投递状态暂时不可用",
    });
  });

  it("读取时 DNS 错误只关闭 Webhook 状态且不暴露完整地址", async () => {
    mocks.assertPublic.mockRejectedValueOnce(
      new Error("lookup https://hooks.example.com/adobe failed")
    );

    const output = await getAdobeCredentialNotificationSettings();

    expect(output.webhookHost).toBe("hooks.example.com");
    expect(output.webhookConfigured).toBe(false);
    expect(JSON.stringify(output)).not.toContain("/adobe");
  });

  it("空更新被契约拒绝", async () => {
    await expect(
      setAdobeCredentialNotificationSettings({}, "super-1")
    ).rejects.toMatchObject({
      name: "AdobeCredentialNotificationSettingsError",
      code: "validation_error",
    });
  });
});
