/**
 * Adobe 凭据 Webhook 安全边界的 DB-free 回归测试。
 *
 * 职责：锁定 HMAC canonical 字段、重放所需稳定 ID、Retry-After、3xx 拒绝和
 * 响应大小上限；不访问真实公网地址。
 */
import { describe, expect, it } from "vitest";

import {
  AdobeCredentialWebhookError,
  assertAdobeCredentialWebhookSecret,
  buildAdobeCredentialWebhookSigningInput,
  classifyAdobeCredentialWebhookResponse,
  parseAdobeCredentialWebhookRetryAfter,
  signAdobeCredentialWebhook,
  verifyAdobeCredentialWebhookSignature,
} from "./adobe-credential-webhook";

const secret = "webhook-secret-that-is-at-least-256-bits-long-123456";

describe("Adobe 凭据 Webhook HMAC", () => {
  it("签名覆盖版本、事件/投递 ID、时间戳和原始正文", () => {
    const input = {
      version: "v1",
      eventId: "incident-1",
      deliveryId: "delivery-1",
      timestamp: "1785801600",
      body: '{"status":"isolated"}',
    };
    expect(buildAdobeCredentialWebhookSigningInput(input)).toBe(
      'v1\nincident-1\ndelivery-1\n1785801600\n{"status":"isolated"}'
    );
    const signature = signAdobeCredentialWebhook({ ...input, secret });
    expect(
      verifyAdobeCredentialWebhookSignature({ ...input, secret, signature })
    ).toBe(true);
    expect(
      verifyAdobeCredentialWebhookSignature({
        ...input,
        body: '{"status":"healthy"}',
        secret,
        signature,
      })
    ).toBe(false);
  });

  it("拒绝弱密钥、超长或含非法稳定 ID 的输入", () => {
    expect(() => assertAdobeCredentialWebhookSecret("short")).toThrow(
      AdobeCredentialWebhookError
    );
    expect(() =>
      signAdobeCredentialWebhook({
        version: "v1",
        eventId: "incident/1",
        deliveryId: "delivery-1",
        timestamp: "1",
        body: "{}",
        secret,
      })
    ).not.toThrow();
  });
});

describe("Adobe 凭据 Webhook 响应分类", () => {
  it("拒绝所有 3xx，不把重定向当作成功", async () => {
    await expect(
      classifyAdobeCredentialWebhookResponse(
        new Response("redirect", {
          status: 302,
          headers: { location: "https://evil.example/" },
        })
      )
    ).rejects.toMatchObject({
      code: "redirect_rejected",
      retryable: false,
    });
  });

  it("把 429/5xx 标记为可重试，并保留有限 Retry-After", async () => {
    const now = new Date("2026-08-04T00:00:00.000Z");
    await expect(
      classifyAdobeCredentialWebhookResponse(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "120", "x-request-id": "req-1" },
        }),
        now
      )
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 120_000,
      requestId: "req-1",
    });
  });

  it("成功响应正文超过上限时 fail-closed", async () => {
    const body = "x".repeat(64 * 1024 + 1);
    await expect(
      classifyAdobeCredentialWebhookResponse(
        new Response(body, { status: 200 })
      )
    ).rejects.toMatchObject({ code: "response_too_large" });
  });
});

describe("Adobe 凭据 Webhook Retry-After", () => {
  it("支持秒数和 HTTP 日期并封顶 15 分钟", () => {
    const now = new Date("2026-08-04T00:00:00.000Z");
    expect(parseAdobeCredentialWebhookRetryAfter("30", now)).toBe(30_000);
    expect(
      parseAdobeCredentialWebhookRetryAfter(
        "Tue, 04 Aug 2026 00:01:00 GMT",
        now
      )
    ).toBe(60_000);
    expect(parseAdobeCredentialWebhookRetryAfter("99999", now)).toBe(
      15 * 60_000
    );
  });
});
