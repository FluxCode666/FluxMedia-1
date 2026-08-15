/** 支付宝当面付纯逻辑测试：交易状态和金额格式是履约前的最小门槛。 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// 当面付适配器的纯逻辑不应连接数据库；mock 运行时设置读取，避免
// system-settings 顶层依赖 @repo/database 让 DB-free 单测要求 DATABASE_URL。
vi.mock("../system-settings", () => ({
  getRuntimeSettingBoolean: vi.fn(),
  getRuntimeSettingNumber: vi.fn(),
  getRuntimeSettingString: vi.fn(),
}));
vi.mock("../config/payment", () => ({
  getBaseUrl: () => "https://example.com",
}));

import {
  getRuntimeSettingNumber,
  getRuntimeSettingString,
} from "../system-settings";

import {
  formatAlipayCnyAmount,
  getRuntimeAlipayF2FConfig,
  isSuccessfulAlipayTradeStatus,
  parseAlipayCnyAmountMinor,
  parseAlipayPaymentTime,
  resolveAlipayPaymentEventTime,
} from "./alipay-f2f";

function mockRuntimeAlipaySettings(overrides?: Record<string, string>) {
  const values = {
    ALIPAY_APP_ID: "app-id",
    ALIPAY_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----test",
    ALIPAY_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----test",
    ALIPAY_SELLER_ID: "seller-id",
    ALIPAY_GATEWAY: "https://openapi.alipay.com/gateway.do",
    ALIPAY_NOTIFY_URL: "https://example.com/api/webhooks/alipay",
    ...overrides,
  };
  vi.mocked(getRuntimeSettingString).mockImplementation(async (key) =>
    Object.hasOwn(values, key) ? values[key as keyof typeof values] : undefined
  );
  vi.mocked(getRuntimeSettingNumber).mockResolvedValue(30);
}

describe("支付宝当面付纯逻辑", () => {
  it("仅允许已完成交易状态履约", () => {
    expect(isSuccessfulAlipayTradeStatus("TRADE_SUCCESS")).toBe(true);
    expect(isSuccessfulAlipayTradeStatus("TRADE_FINISHED")).toBe(true);
    expect(isSuccessfulAlipayTradeStatus("WAIT_BUYER_PAY")).toBe(false);
    expect(isSuccessfulAlipayTradeStatus(undefined)).toBe(false);
  });

  it("将 CNY 金额固定为两位小数并拒绝非正数", () => {
    expect(formatAlipayCnyAmount(1)).toBe("1.00");
    expect(formatAlipayCnyAmount(1.2)).toBe("1.20");
    expect(() => formatAlipayCnyAmount(0)).toThrow("订单金额无效");
  });

  it("严格解析回调金额为分", () => {
    expect(parseAlipayCnyAmountMinor("1")).toBe(100);
    expect(parseAlipayCnyAmountMinor("1.2")).toBe(120);
    expect(parseAlipayCnyAmountMinor("1.20")).toBe(120);
    expect(parseAlipayCnyAmountMinor("1.200")).toBeNull();
    expect(parseAlipayCnyAmountMinor("-1")).toBeNull();
  });

  it("使用支付宝付款时间而不是跨日延迟通知的接收时间", () => {
    expect(
      resolveAlipayPaymentEventTime(
        "2026-08-13 23:59:30",
        new Date("2026-08-14T04:00:00.000Z")
      )
    ).toEqual({
      occurredAt: new Date("2026-08-13T15:59:30.000Z"),
      timestampSource: "provider",
    });
  });

  it("付款时间缺失或非法时降级为服务器接收时间", () => {
    const receivedAt = new Date("2026-08-14T04:00:00.000Z");
    expect(resolveAlipayPaymentEventTime(undefined, receivedAt)).toEqual({
      occurredAt: receivedAt,
      timestampSource: "server_received",
    });
    expect(
      resolveAlipayPaymentEventTime("2026-02-30 12:00:00", receivedAt)
    ).toEqual({
      occurredAt: receivedAt,
      timestampSource: "server_received",
    });
    expect(parseAlipayPaymentTime("2026-08-14T12:00:00Z")).toBeNull();
  });

  it("允许直连当面付省略卖家 PID，并自动补全通知路由", async () => {
    mockRuntimeAlipaySettings({ ALIPAY_SELLER_ID: "" });
    const config = await getRuntimeAlipayF2FConfig();
    expect(config.appId).toBe("app-id");
    expect(config.sellerId).toBeUndefined();

    mockRuntimeAlipaySettings({ ALIPAY_NOTIFY_URL: "http://example.com" });
    await expect(getRuntimeAlipayF2FConfig()).resolves.toMatchObject({
      notifyUrl: "http://example.com/api/webhooks/alipay",
    });

    mockRuntimeAlipaySettings({ ALIPAY_NOTIFY_URL: "http://example.com/hook" });
    await expect(getRuntimeAlipayF2FConfig()).resolves.toMatchObject({
      notifyUrl: "http://example.com/hook",
    });

    mockRuntimeAlipaySettings({ ALIPAY_NOTIFY_URL: "ftp://example.com/hook" });
    await expect(getRuntimeAlipayF2FConfig()).rejects.toThrow(
      "必须使用 HTTP 或 HTTPS"
    );
  });

  it("兼容支付宝后台粘贴的单行 Base64 密钥", async () => {
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const compactPrivateKey = keys.privateKey.replace(
      /-----[^-]+-----|\s/g,
      ""
    );
    const compactPublicKey = keys.publicKey.replace(/-----[^-]+-----|\s/g, "");

    mockRuntimeAlipaySettings({
      ALIPAY_PRIVATE_KEY: compactPrivateKey,
      ALIPAY_PUBLIC_KEY: compactPublicKey,
    });
    const config = await getRuntimeAlipayF2FConfig();

    expect(config.privateKey).toContain("BEGIN RSA PRIVATE KEY");
    expect(config.alipayPublicKey).toContain("BEGIN PUBLIC KEY");
  });
});
