import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// creem.ts 仅从 system-settings 引入 getRuntimeSettingString，
// 而 system-settings 会拉起 @repo/database。被测纯逻辑不读取运行时设置，
// 故在此 mock 掉该依赖，使本文件保持 DB-free（CLAUDE.md 要求纯函数可在不 import
// @repo/database 下单测）。
const getRuntimeSettingStringMock = vi.hoisted(() => vi.fn());

vi.mock("../system-settings", () => ({
  getRuntimeSettingString: getRuntimeSettingStringMock,
}));

import {
  assertRuntimeCreemCheckoutConfigured,
  creem,
  parseCreemWebhookEvent,
  verifyCreemWebhookSignature,
} from "./creem";

afterEach(() => {
  getRuntimeSettingStringMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Creem 配置门槛", () => {
  it("缺少结账配置时在本地拒绝，绝不发起 HTTP 请求", async () => {
    getRuntimeSettingStringMock.mockResolvedValue("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      creem.createCheckout({
        product_id: "product_1",
        success_url: "https://example.com/success",
      })
    ).rejects.toThrow("Creem API Key 未配置");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("要求 API Key 与 Webhook Secret 同时存在", async () => {
    getRuntimeSettingStringMock.mockImplementation(async (key: string) => {
      return key === "CREEM_API_KEY" ? "creem_test_key" : "";
    });

    await expect(assertRuntimeCreemCheckoutConfigured()).rejects.toThrow(
      "Creem 支付通道未完整配置"
    );
  });

  it("完整配置允许创建结账前校验通过", async () => {
    getRuntimeSettingStringMock.mockImplementation(async (key: string) => {
      return key === "CREEM_API_KEY" ? "creem_test_key" : "webhook_secret";
    });

    await expect(
      assertRuntimeCreemCheckoutConfigured()
    ).resolves.toBeUndefined();
  });
});

describe("parseCreemWebhookEvent", () => {
  const validEvent = {
    id: "evt_1",
    eventType: "checkout.completed",
    object: { id: "ch_1", metadata: { userId: "u_1" } },
    created_at: 1700000000000,
  };

  it("接受结构合法的事件体并保留 object 未知字段", () => {
    const parsed = parseCreemWebhookEvent(JSON.stringify(validEvent));
    expect(parsed.eventType).toBe("checkout.completed");
    expect(parsed.id).toBe("evt_1");
    expect(
      (parsed.object as { metadata?: { userId?: string } }).metadata?.userId
    ).toBe("u_1");
  });

  it("拒绝非法 JSON", () => {
    expect(() => parseCreemWebhookEvent("{not json")).toThrow(/not valid JSON/);
  });

  it("拒绝未知 eventType", () => {
    expect(() =>
      parseCreemWebhookEvent(
        JSON.stringify({ ...validEvent, eventType: "subscription.unknown" })
      )
    ).toThrow(/Invalid webhook event shape/);
  });

  it("拒绝 object 非对象", () => {
    expect(() =>
      parseCreemWebhookEvent(
        JSON.stringify({ ...validEvent, object: "not-an-object" })
      )
    ).toThrow(/Invalid webhook event shape/);
  });

  it("拒绝缺失必填字段", () => {
    const { created_at: _omit, ...withoutCreatedAt } = validEvent;
    expect(() =>
      parseCreemWebhookEvent(JSON.stringify(withoutCreatedAt))
    ).toThrow(/Invalid webhook event shape/);
  });
});

describe("verifyCreemWebhookSignature", () => {
  // 用已知密钥+载荷计算 HMAC-SHA256，验证恒定时间比对在长度/内容上的行为。
  const secret = "whsec_test";
  const payload = '{"id":"evt_1"}';

  it("正确签名通过校验", () => {
    const signature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    expect(verifyCreemWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it("错误签名不通过", () => {
    expect(verifyCreemWebhookSignature(payload, "deadbeef", secret)).toBe(
      false
    );
  });
});
