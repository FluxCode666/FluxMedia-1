/**
 * 统一媒体后端分组契约测试。
 *
 * 职责：锁定分组双价格、无模式边界、队列优先级和旧 metadata 字段级安全清理。
 */

import { describe, expect, it } from "vitest";

import {
  backendGroupInputSchema,
  backendGroupMetadataSchema,
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
  videoCreditsPerItemOverrides: {},
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
      videoCreditsPerItemOverrides: {},
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

  it("分别保存按秒和按条稀疏覆盖但严格拒绝计费模式", () => {
    const input = {
      ...validGroup,
      videoCreditOverrides: {
        sora2: 40,
        "sora2@1080p": 50,
      },
      videoCreditsPerItemOverrides: {
        sora2: 3,
        "sora2@1080p": 5,
      },
    };

    expect(backendGroupInputSchema.parse(input)).toMatchObject({
      videoCreditOverrides: input.videoCreditOverrides,
      videoCreditsPerItemOverrides: input.videoCreditsPerItemOverrides,
    });
    expect(createBackendGroupMetadata(input)).toEqual({
      imageCreditOverrides: { version: 1, byModel: {} },
      videoCreditOverrides: input.videoCreditOverrides,
      videoCreditsPerItemOverrides: input.videoCreditsPerItemOverrides,
      childGroupIds: [],
    });
    expect(
      backendGroupInputSchema.safeParse({
        ...input,
        videoBillingMode: "per_item",
      }).success
    ).toBe(false);
    expect(
      backendGroupInputSchema.safeParse({
        ...input,
        videoBillingModes: { sora2: "per_item" },
      }).success
    ).toBe(false);
    expect(
      backendGroupMetadataSchema.safeParse({
        ...createBackendGroupMetadata(input),
        videoBillingModes: { sora2: "per_item" },
      }).success
    ).toBe(false);
    expect(
      backendGroupSummarySchema.safeParse({
        ...input,
        id: "group-a",
        description: null,
        billingMode: "per_item",
      }).success
    ).toBe(false);
  });

  it("损坏任一视频价格字段时保留其他 metadata 字段", () => {
    expect(
      parseBackendGroupMetadata({
        imageCreditOverrides: {
          version: 1,
          byModel: { "gpt-image-2": { base1kCredits: 2 } },
        },
        videoCreditOverrides: { sora2: 0 },
        videoCreditsPerItemOverrides: { "sora2@1080p": 5 },
        childGroupIds: ["child-a"],
      })
    ).toEqual({
      imageCreditOverrides: {
        version: 1,
        byModel: { "gpt-image-2": { base1kCredits: 2 } },
      },
      videoCreditOverrides: {},
      videoCreditsPerItemOverrides: { "sora2@1080p": 5 },
      childGroupIds: ["child-a"],
    });

    expect(
      parseBackendGroupMetadata({
        imageCreditOverrides: { version: 1, byModel: {} },
        videoCreditOverrides: { "sora2@720p": 30 },
        videoCreditsPerItemOverrides: { "sora2@1080p": -1 },
        childGroupIds: ["child-b"],
      })
    ).toEqual({
      imageCreditOverrides: { version: 1, byModel: {} },
      videoCreditOverrides: { "sora2@720p": 30 },
      videoCreditsPerItemOverrides: {},
      childGroupIds: ["child-b"],
    });
  });
});
