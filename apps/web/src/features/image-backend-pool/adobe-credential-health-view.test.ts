/**
 * Adobe 凭据健康视图纯函数测试。
 *
 * 职责：锁定状态层级、首要动作和诊断 allowlist 的渲染边界，不加载 React、数据库或网络。
 */
import { describe, expect, it } from "vitest";

import {
  getAdobeCredentialProfileViews,
  getAdobeHealthDiagnosticEntries,
  getAdobeHealthStatusView,
  getEffectiveAdobeHealthStatus,
} from "./adobe-credential-health-view-model";

const healthySummary = {
  memberId: "member-1",
  status: "healthy" as const,
  consecutiveFailures: 0,
  failureProfiles: [] as Array<"express" | "firefly">,
  lastCheckedAt: "2026-08-04T00:00:00.000Z",
  lastSuccessAt: "2026-08-04T00:00:00.000Z",
  nextCheckAt: "2026-08-04T00:45:00.000Z",
  evaluationDeadlineAt: null,
  isolatedAt: null,
  diagnostic: null,
};

describe("Adobe 凭据健康视图映射", () => {
  it("隔离状态突出重新授权，健康状态不要求动作", () => {
    expect(getAdobeHealthStatusView("isolated")).toMatchObject({
      label: "已隔离",
      variant: "destructive",
      primaryAction: "reauthorize",
    });
    expect(getAdobeHealthStatusView("healthy")).toMatchObject({
      label: "健康",
      variant: "secondary",
      primaryAction: "none",
    });
  });

  it("只渲染严格 allowlist 诊断字段", () => {
    expect(
      getAdobeHealthDiagnosticEntries({
        statusCode: 401,
        adobeErrorCode: "expired_token",
        message: "session expired",
        requestId: "req-1",
      })
    ).toEqual([
      { label: "HTTP 状态", value: "401" },
      { label: "Adobe 错误码", value: "expired_token" },
      { label: "消息", value: "session expired" },
      { label: "请求 ID", value: "req-1" },
    ]);
  });

  it("没有诊断时返回空列表", () => {
    expect(getAdobeHealthDiagnosticEntries(null)).toEqual([]);
  });

  it("只有双 Profile 都通过时才把账号凭据展示为健康", () => {
    expect(getAdobeCredentialProfileViews(healthySummary)).toEqual({
      express: "健康",
      firefly: "健康",
    });
    expect(
      getAdobeCredentialProfileViews({
        ...healthySummary,
        status: "degraded",
        consecutiveFailures: 1,
        failureProfiles: ["firefly"],
      })
    ).toEqual({ express: "健康", firefly: "异常" });
  });

  it("超过探测完成窗口后不继续展示为健康", () => {
    expect(
      getEffectiveAdobeHealthStatus(
        healthySummary,
        new Date("2026-08-04T00:50:00.001Z")
      )
    ).toBe("overdue");
  });
});
