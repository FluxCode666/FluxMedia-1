/**
 * Adobe 凭据健康视图纯函数测试。
 *
 * 职责：锁定状态层级、首要动作和诊断 allowlist 的渲染边界，不加载 React、数据库或网络。
 */
import { describe, expect, it } from "vitest";

import {
  getAdobeHealthDiagnosticEntries,
  getAdobeHealthStatusView,
} from "./adobe-credential-health-view-model";

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
});
