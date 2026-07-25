/**
 * Dashboard 首屏错误分类器的 DB-free 回归测试。
 *
 * 验证读模型准备中、明确 PostgreSQL 超时和通用会话失败使用不同提示，其他异常继续
 * 交给错误边界，避免把未知错误错误地描述为数据库超时。
 */
import { OperationError } from "@repo/shared/uol/errors";
import { describe, expect, it } from "vitest";

import { getDashboardLoadFailureReason } from "./dashboard-load-error";

describe("dashboard load error classification", () => {
  it("classifies known recoverable states", () => {
    expect(
      getDashboardLoadFailureReason(
        new OperationError("not_ready", "Analytics is building")
      )
    ).toBe("not_ready");
    expect(
      getDashboardLoadFailureReason(
        new OperationError("timeout", "Database query timed out", {
          source: "postgres",
        })
      )
    ).toBe("query_timeout");
    expect(
      getDashboardLoadFailureReason({
        body: { code: "FAILED_TO_GET_SESSION" },
      })
    ).toBe("query_unavailable");
  });

  it("does not misclassify unrelated timeouts or unknown failures", () => {
    expect(
      getDashboardLoadFailureReason(
        new OperationError("timeout", "Image provider timed out", {
          source: "image-provider",
        })
      )
    ).toBeNull();
    expect(getDashboardLoadFailureReason(new Error("unknown"))).toBeNull();
  });
});
