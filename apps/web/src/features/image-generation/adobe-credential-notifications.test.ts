/**
 * Adobe 凭据通知策略的回归测试。
 *
 * 职责：锁定通知正文脱敏、分渠道配置 revision、故障事件幂等语义和 8 次
 * 有限退避；数据库投递在集成测试中验证，本文件不访问真实 SMTP/Webhook。
 */
import { describe, expect, it } from "vitest";

import {
  buildAdobeCredentialNotificationConfigRevision,
  buildAdobeCredentialNotificationPayload,
  getAdobeCredentialNotificationRetryAt,
} from "./adobe-credential-notifications";

const now = new Date("2026-08-04T00:00:00.000Z");

describe("Adobe 凭据通知 payload", () => {
  it("只保留分类和 allowlist 标识，不携带原始 message 或 Cookie", () => {
    const payload = buildAdobeCredentialNotificationPayload({
      eventType: "failure",
      incidentId: "incident-1",
      memberId: "member-1",
      memberName: "Adobe A",
      status: "isolated",
      consecutiveFailures: 3,
      failureProfiles: ["express", "firefly"],
      failureCategory: "auth_rejected",
      diagnostic: {
        statusCode: 401,
        adobeErrorCode: "invalid_token",
        message: "Authorization: Bearer secret-token",
        requestId: "req-1",
      },
      occurredAt: now,
    });

    expect(payload).toMatchObject({
      eventType: "failure",
      status: "isolated",
      failureCategory: "auth_rejected",
      diagnostic: {
        statusCode: 401,
        adobeErrorCode: "invalid_token",
        requestId: "req-1",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("Bearer");
    expect(JSON.stringify(payload)).not.toContain("secret-token");
    expect(payload.diagnostic).not.toHaveProperty("message");
  });
});

describe("Adobe 凭据通知 revision", () => {
  it("收件人、地址或 HMAC 指纹变化会使旧 envelope 失效", () => {
    const emailA = buildAdobeCredentialNotificationConfigRevision({
      channel: "email",
      targetEnvelope: { recipients: ["ops@example.com"] },
      providerFingerprint: "provider-a",
    });
    const emailB = buildAdobeCredentialNotificationConfigRevision({
      channel: "email",
      targetEnvelope: { recipients: ["security@example.com"] },
      providerFingerprint: "provider-a",
    });
    const webhookA = buildAdobeCredentialNotificationConfigRevision({
      channel: "webhook",
      targetEnvelope: {
        url: "https://hooks.example.com/adobe",
        secretFingerprint: "secret-a",
      },
      providerFingerprint: "secret-a",
    });
    const webhookB = buildAdobeCredentialNotificationConfigRevision({
      channel: "webhook",
      targetEnvelope: {
        url: "https://hooks.example.com/adobe",
        secretFingerprint: "secret-b",
      },
      providerFingerprint: "secret-b",
    });
    expect(emailA).not.toBe(emailB);
    expect(webhookA).not.toBe(webhookB);
  });
});

describe("Adobe 凭据通知退避", () => {
  it("从 30 秒指数退避、Retry-After 取较大值并在第 8 次后终止", () => {
    expect(getAdobeCredentialNotificationRetryAt(1, now)).toEqual(
      new Date("2026-08-04T00:00:30.000Z")
    );
    expect(getAdobeCredentialNotificationRetryAt(2, now)).toEqual(
      new Date("2026-08-04T00:01:00.000Z")
    );
    expect(getAdobeCredentialNotificationRetryAt(3, now, 600_000)).toEqual(
      new Date("2026-08-04T00:10:00.000Z")
    );
    expect(getAdobeCredentialNotificationRetryAt(8, now)).toBeNull();
  });
});
