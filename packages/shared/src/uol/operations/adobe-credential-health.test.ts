/**
 * Adobe direct 凭据健康 UOL 契约测试。
 *
 * 职责：锁定后台任务、管理员入口和通知配置的权限边界、human-only 暴露
 * 以及严格输入输出 schema；不触发 Adobe 网络请求或数据库副作用。
 * 使用方：Vitest 与 UOL registry 回归测试。
 */
import { describe, expect, it } from "vitest";

import {
  adobeCredentialHealthCheck,
  adobeCredentialHealthCleanup,
  adobeCredentialHealthDetails,
  adobeCredentialHealthScan,
  adobeCredentialNotificationDrain,
  adobeCredentialReauthorize,
  getAdobeCredentialNotificationSettings,
  setAdobeCredentialNotificationSettings,
} from "./adobe-credential-health";

describe("Adobe credential health operations", () => {
  it("后台 operation 使用精确 job access 且不接受泛化 system Principal", () => {
    for (const [operation, job] of [
      [adobeCredentialHealthScan, "adobe-credential-health"],
      [
        adobeCredentialNotificationDrain,
        "adobe-credential-notification-delivery",
      ],
      [adobeCredentialHealthCleanup, "adobe-credential-health-retention"],
    ] as const) {
      expect(operation.access).toEqual({
        kind: "cronJob",
        job,
      });
      expect(operation.agentExposure).toBe("human-only");
      expect(operation.hasMaintenanceWrite).toBe(true);
    }
  });

  it("管理员检查、详情和重新授权只接受真实管理员且不投影到 Agent", () => {
    for (const operation of [
      adobeCredentialHealthCheck,
      adobeCredentialHealthDetails,
      adobeCredentialReauthorize,
    ]) {
      expect(operation.access).toEqual({
        kind: "roles",
        roles: ["admin", "super_admin"],
      });
      expect(operation.agentExposure).toBe("human-only");
    }
  });

  it("健康入口严格校验成员 ID，详情输出只允许清洗诊断字段", () => {
    expect(
      adobeCredentialHealthCheck.input.safeParse({
        memberId: "member-a",
      }).success
    ).toBe(true);
    expect(
      adobeCredentialHealthCheck.input.safeParse({
        memberId: "member-a",
        raw: "must-not-be-accepted",
      }).success
    ).toBe(false);
    expect(
      adobeCredentialHealthDetails.output.safeParse({
        memberId: "member-a",
        status: "isolated",
        consecutiveFailures: 3,
        failureProfiles: ["express"],
        lastCheckedAt: null,
        lastSuccessAt: null,
        nextCheckAt: null,
        evaluationDeadlineAt: null,
        isolatedAt: "2026-08-04T00:00:00.000Z",
        diagnostic: {
          statusCode: 401,
          adobeErrorCode: "unauthorized",
          message: "session expired",
          requestId: "req-1",
        },
      }).success
    ).toBe(true);
    expect(
      adobeCredentialHealthDetails.output.safeParse({
        memberId: "member-a",
        status: "isolated",
        consecutiveFailures: 3,
        failureProfiles: ["express"],
        lastCheckedAt: null,
        lastSuccessAt: null,
        nextCheckAt: null,
        evaluationDeadlineAt: null,
        isolatedAt: null,
        diagnostic: { raw: "cookie=secret" },
      }).success
    ).toBe(false);
  });

  it("通知配置只允许收件人和无凭据 HTTPS 地址，并隐藏部署密钥", () => {
    expect(
      getAdobeCredentialNotificationSettings.output.safeParse({
        emailRecipients: ["ops@example.com"],
        emailConfigured: true,
        webhookHost: "hooks.example.com",
        webhookConfigured: true,
        webhookHmacConfigured: true,
      }).success
    ).toBe(true);
    expect(
      setAdobeCredentialNotificationSettings.input.safeParse({
        emailRecipients: ["ops@example.com"],
        webhookUrl: "https://hooks.example.com/adobe",
      }).success
    ).toBe(true);
    expect(
      setAdobeCredentialNotificationSettings.input.safeParse({
        emailRecipients: [],
        webhookUrl: "https://hooks.example.com/adobe?token=secret",
      }).success
    ).toBe(false);
    expect(
      setAdobeCredentialNotificationSettings.input.safeParse({
        emailRecipients: ["ops@example.com"],
        webhookUrl: "http://hooks.example.com/adobe",
      }).success
    ).toBe(false);
    expect(setAdobeCredentialNotificationSettings.agentExposure).toBe(
      "human-only"
    );
  });
});
