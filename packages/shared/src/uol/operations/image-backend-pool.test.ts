/**
 * 生图后端池 UOL 计费配置契约测试。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  globalVideoModelCreditsPerSecondSchema,
} from "../../adobe/video-pricing";
import {
  createDefaultGlobalImageCreditOverrides,
  globalImageCreditOverridesSchema,
} from "../../image-backend/group-image-pricing";
import { getOperation } from "../registry";

import { deleteMember, saveGroup, saveMember } from "./image-backend-pool";
import "./external-api";
import "./image-generation";

const validGroup = {
  name: "默认组",
  isEnabled: true,
  isDefault: true,
  isUserSelectable: true,
  contentSafety: "inherit" as const,
  minPlan: "free" as const,
  imageCreditOverrides: { version: 1 as const, byModel: {} },
  videoCreditOverrides: {},
  childGroupIds: [],
  priority: 50,
};

describe("image backend pool pricing operations", () => {
  it("pool.saveGroup 接受真实分组字段和稀疏图像价格覆盖", () => {
    expect(
      saveGroup.input.safeParse({
        ...validGroup,
        imageCreditOverrides: {
          version: 1,
          byModel: { "custom-image-v3": { base2kCredits: 6 } },
        },
        videoCreditOverrides: { sora2: 42 },
      }).success
    ).toBe(true);
  });

  it("pool.saveGroup 拒绝非法价格并允许空覆盖继承全局", () => {
    expect(saveGroup.input.safeParse(validGroup).success).toBe(true);
    expect(
      saveGroup.input.safeParse({
        ...validGroup,
        imageCreditOverrides: {
          version: 1,
          byModel: { "gpt-image-2": { base1024Credits: 0 } },
        },
      }).success
    ).toBe(false);
    expect(
      saveGroup.input.safeParse({
        ...validGroup,
        videoCreditOverrides: { sora2: 0 },
      }).success
    ).toBe(false);
  });

  it("全局图像固定价格与视频模型每秒积分使用不同契约", () => {
    expect(
      globalImageCreditOverridesSchema.safeParse(
        createDefaultGlobalImageCreditOverrides()
      ).success
    ).toBe(true);
    expect(
      globalVideoModelCreditsPerSecondSchema.safeParse(
        DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND
      ).success
    ).toBe(true);
    expect(
      globalImageCreditOverridesSchema.safeParse({
        version: 1,
        byModel: { "gpt-image-2": {} },
      }).success
    ).toBe(false);
    expect(
      globalVideoModelCreditsPerSecondSchema.safeParse({
        ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
        sora2: 0,
      }).success
    ).toBe(false);
    expect(
      globalVideoModelCreditsPerSecondSchema.safeParse({
        ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
        sora2: 100_001,
      }).success
    ).toBe(false);
  });

  it("不再将历史倍率作为分组或后端保存契约", () => {
    expect(
      saveGroup.input.safeParse({
        ...validGroup,
        videoBillingMultiplier: 2,
      }).success
    ).toBe(false);
    expect(
      saveMember.input.safeParse({
        type: "api",
        name: "API",
        groupIds: ["group-a"],
        supportedModelIds: ["gpt-image-2"],
        contentSafetyEnabled: true,
        isEnabled: true,
        alwaysActive: false,
        failureCooldownEnabled: false,
        priority: 0,
        concurrency: 1,
        config: {
          baseUrl: "https://example.com",
          parameterMappings: [],
        },
        billingMultiplier: 2,
      }).success
    ).toBe(false);
    expect(
      saveMember.input.safeParse({
        type: "adobe",
        name: "Adobe",
        groupIds: ["group-a"],
        supportedModelIds: ["gpt-image-2"],
        contentSafetyEnabled: true,
        isEnabled: true,
        alwaysActive: false,
        failureCooldownEnabled: false,
        priority: 0,
        concurrency: 1,
        config: {
          mode: "direct",
          defaultRatio: "1x1",
          defaultResolution: "2k",
          gptImageQuality: "high",
        },
        billingMultiplier: 2,
      }).success
    ).toBe(false);
  });

  it("统一成员保存和删除不再接受旧类型分流字段", () => {
    expect(
      saveMember.input.safeParse({
        type: "api",
        name: "API",
        groupIds: ["group-a"],
        supportedModelIds: ["gpt-image-2"],
        contentSafetyEnabled: true,
        isEnabled: true,
        alwaysActive: false,
        failureCooldownEnabled: true,
        priority: 0,
        concurrency: 1,
        config: {
          baseUrl: "https://example.com",
          parameterMappings: [],
        },
      }).success
    ).toBe(true);
    expect(
      deleteMember.input.safeParse({ id: "member-a", memberType: "api" })
        .success
    ).toBe(false);
  });

  it.each([
    "pool.saveAccount",
    "pool.saveApi",
    "pool.saveAdobe",
    "pool.importFromRefreshTokens",
    "pool.getSub2ApiStatus",
    "pool.syncSub2ApiAccounts",
    "pool.cronSub2ApiSync",
    "pool.cronRefreshStale",
    "externalApi.generateImages",
    "externalApi.editImages",
    "externalApi.chatCompletions",
    "externalApi.responses",
    "externalApi.agentImages",
    "file.generatePpt",
    "file.generatePsd",
    "image.selectWebCandidate",
    "image.exportPsd",
  ])("registry 不再包含已退场 operation %s", (name) => {
    expect(getOperation(name)).toBeUndefined();
  });
});
