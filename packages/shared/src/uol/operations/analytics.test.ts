/**
 * 用户 Analytics UOL 操作注册测试。
 *
 * 使用方：Vitest；固定新数据看板 operation 的本人权限、strict schema 和 Agent 暴露
 * 元数据，同时保护既有摘要与趋势 operation 的名称和权限不被 U1 改写。
 */
import { describe, expect, it } from "vitest";

import {
  getAdminDataDashboard,
  getMyDataDashboard,
  getMyUsageSummary,
  getMyUsageTrends,
  searchAdminDataDashboardUsers,
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

describe("analytics.getAdminDataDashboard", () => {
  it("注册为管理员可读、天然幂等且无副作用的全站 operation", () => {
    expect(getAdminDataDashboard).toMatchObject({
      name: "analytics.getAdminDataDashboard",
      domain: "analytics",
      access: { kind: "roles", roles: ["admin", "super_admin"] },
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
  });

  it("支持日期范围和可选用户 ID，拒绝邮箱或未知筛选字段", () => {
    expect(getAdminDataDashboard.input.safeParse({}).success).toBe(true);
    expect(
      getAdminDataDashboard.input.safeParse({
        startDate: "2026-08-03",
        endDate: "2026-08-09",
      }).success
    ).toBe(true);
    expect(
      getAdminDataDashboard.input.safeParse({ userId: "another-user" }).success
    ).toBe(true);
    expect(
      getAdminDataDashboard.input.safeParse({ userEmail: "a@example.com" })
        .success
    ).toBe(false);
  });
});

describe("analytics.searchAdminDataDashboardUsers", () => {
  it("注册为人工管理员只读搜索 operation", () => {
    expect(searchAdminDataDashboardUsers).toMatchObject({
      name: "analytics.searchAdminDataDashboardUsers",
      access: { kind: "roles", roles: ["admin", "super_admin"] },
      agentExposure: "human-only",
      readOnly: true,
      destructive: false,
    });
    expect(
      searchAdminDataDashboardUsers.input.safeParse({ query: "张", limit: 20 })
        .success
    ).toBe(true);
  });
});
