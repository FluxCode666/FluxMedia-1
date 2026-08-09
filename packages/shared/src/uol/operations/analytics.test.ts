/**
 * 用户 Analytics UOL 操作注册测试。
 *
 * 使用方：Vitest；固定新数据看板 operation 的本人权限、strict schema 和 Agent 暴露
 * 元数据，同时保护既有摘要与趋势 operation 的名称和权限不被 U1 改写。
 */
import { describe, expect, it } from "vitest";

import {
  getMyDataDashboard,
  getMyUsageSummary,
  getMyUsageTrends,
} from "./analytics";

describe("analytics.getMyDataDashboard", () => {
  it("注册为 user-only、天然幂等且无副作用的本人只读 operation", () => {
    expect(getMyDataDashboard).toMatchObject({
      name: "analytics.getMyDataDashboard",
      domain: "analytics",
      access: { kind: "user" },
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
    expect(getMyDataDashboard).not.toHaveProperty("agentExposure");
  });

  it("严格拒绝调用方身份和旧趋势字段", () => {
    expect(getMyDataDashboard.input.safeParse({}).success).toBe(true);
    expect(
      getMyDataDashboard.input.safeParse({
        startDate: "2026-08-03",
        endDate: "2026-08-09",
      }).success
    ).toBe(true);

    for (const input of [
      { userId: "another-user" },
      { principalId: "another-user" },
      { granularity: "day" },
      { metric: "imageCount" },
    ]) {
      expect(getMyDataDashboard.input.safeParse(input).success).toBe(false);
    }
  });

  it("保持既有摘要和趋势 operation 的契约不变", () => {
    expect(getMyUsageSummary).toMatchObject({
      name: "analytics.getMyUsageSummary",
      access: { kind: "protected" },
    });
    expect(getMyUsageTrends).toMatchObject({
      name: "analytics.getMyUsageTrends",
      access: { kind: "protected" },
    });
  });
});
