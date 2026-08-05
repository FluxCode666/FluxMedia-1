/**
 * 统一媒体后端分组契约测试。
 *
 * 职责：锁定分组不再携带套餐门槛、队列优先级边界和旧 metadata 安全清理。
 */

import { describe, expect, it } from "vitest";

import {
  backendGroupInputSchema,
  backendGroupSummarySchema,
  createBackendGroupMetadata,
  parseBackendGroupMetadata,
} from "./group-contract";

const validGroup = {
  name: "默认组",
  isEnabled: true,
  isDefault: true,
  isUserSelectable: true,
  contentSafety: "inherit" as const,
  imageCreditOverrides: { version: 1 as const, byModel: {} },
  videoCreditOverrides: {},
  childGroupIds: [],
  priority: 0,
};

describe("backend group contract", () => {
  it("接受队列优先级边界且严格拒绝套餐门槛", () => {
    expect(backendGroupInputSchema.safeParse(validGroup).success).toBe(true);
    expect(
      backendGroupInputSchema.safeParse({ ...validGroup, priority: 10_000 })
        .success
    ).toBe(true);
    expect(
      backendGroupInputSchema.safeParse({ ...validGroup, minPlan: "free" })
        .success
    ).toBe(false);
  });

  it("解析旧 metadata 时丢弃 minPlan 并保留治理与计费字段", () => {
    expect(
      parseBackendGroupMetadata({
        minPlan: "enterprise",
        imageCreditOverrides: { version: 1, byModel: {} },
        videoCreditOverrides: { sora2: 40 },
        childGroupIds: ["child-a"],
      })
    ).toEqual({
      imageCreditOverrides: { version: 1, byModel: {} },
      videoCreditOverrides: { sora2: 40 },
      childGroupIds: ["child-a"],
    });
    expect(createBackendGroupMetadata(validGroup)).not.toHaveProperty(
      "minPlan"
    );
  });

  it("管理摘要严格拒绝套餐字段", () => {
    const summary = {
      ...validGroup,
      id: "group-a",
      description: null,
    };
    expect(backendGroupSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      backendGroupSummarySchema.safeParse({ ...summary, minPlan: "free" })
        .success
    ).toBe(false);
  });
});
