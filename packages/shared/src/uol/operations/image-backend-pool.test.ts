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

import {
  deleteMember,
  getAdminPool,
  saveGroup,
  saveMember,
} from "./image-backend-pool";
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
          cookie: "cookie-secret",
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

  it("Adobe direct 管理快照保留余额、刷新错误和运行错误", () => {
    const member = {
      id: "adobe-direct",
      name: "Adobe Direct",
      type: "adobe",
      groupIds: ["group-a"],
      supportedModelIds: ["gpt-image-2"],
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      failureCooldownEnabled: true,
      priority: 10,
      concurrency: 2,
      status: "error",
      healthStatus: "unhealthy",
      inflightCount: 0,
      leaseAcquiredCount: 3,
      lastAcquiredAt: "2026-07-27T01:00:00.000Z",
      lastUsedAt: "2026-07-27T01:01:00.000Z",
      lastError: "Adobe upstream unavailable",
      lastErrorAt: "2026-07-27T01:02:00.000Z",
      config: {
        mode: "direct",
        hasCookie: true,
        displayName: "Adobe User",
        email: "user@example.com",
        credentialStatus: "active",
        lastRefreshAt: "2026-07-27T00:00:00.000Z",
        lastRefreshError: null,
        consecutiveFailures: 0,
        fireflyCredentialStatus: null,
        fireflyLastRefreshAt: null,
        fireflyLastRefreshError: null,
        fireflyConsecutiveFailures: 0,
        creditsTotal: 4_000,
        creditsUsed: 1_500,
        creditsAvailable: 2_500,
        creditsUpdatedAt: "2026-07-27T00:00:01.000Z",
        creditsError: null,
        defaultRatio: "1x1",
        defaultResolution: "2k",
        gptImageQuality: "high",
      },
    } as const;
    expect(
      getAdminPool.output.safeParse({ groups: [], members: [member] }).success
    ).toBe(true);
    expect(
      getAdminPool.output.safeParse({
        groups: [],
        members: [
          {
            ...member,
            config: {
              ...member.config,
              fireflyAccessToken: "secret-must-not-cross-uol",
            },
          },
        ],
      }).success
    ).toBe(false);
  });

  it.each([
    "pool.saveAccount",
    "pool.saveApi",
    "pool.saveAdobe",
    "pool.listAdobeAccounts",
    "pool.importAdobeAccount",
    "pool.deleteAdobeAccount",
    "pool.setAdobeAccountEnabled",
    "pool.importFromRefreshTokens",
    "pool.getSub2ApiStatus",
    "pool.syncSub2ApiAccounts",
    "pool.cronSub2ApiSync",
    "pool.cronRefreshStale",
    "externalApi.generateImages",
    "externalApi.editImages",
    "externalApi.chatCompletions",
    ["externalApi", "responses"].join("."),
    ["externalApi", "agentImages"].join("."),
    "file.generatePpt",
    "file.generatePsd",
    "image.exportPsd",
  ])("registry 不再包含已退场 operation %s", (name) => {
    expect(getOperation(name)).toBeUndefined();
  });
});
