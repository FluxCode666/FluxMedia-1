/**
 * 账号池 UOL 计费、成员管理与启用状态契约测试。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  globalVideoModelCreditsPerSecondSchema,
} from "../../video-generation/video-pricing";
import {
  createDefaultGlobalImageCreditOverrides,
  globalImageCreditOverridesSchema,
} from "../../image-backend/group-image-pricing";
import { getOperation } from "../registry";

import {
  adminPoolGroupListInputSchema,
  adminPoolMemberListInputSchema,
  deleteMember,
  getAdminPool,
  getApiUpstreamRuntimeDiagnostics,
  listAdminGroups,
  listAdminMembers,
  resetMemberStatus,
  saveGroup,
  saveMember,
  setMemberEnabled,
  testApiUpstreamAdapter,
} from "./image-backend-pool";
import "./external-api";
import "./image-generation";

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
  priority: 50,
};

describe("image backend pool pricing operations", () => {
  it("管理号池输出接受 API 成员的视频协议模式", () => {
    const result = getAdminPool.output.safeParse({
      groups: [],
      members: [
        {
          id: "api-member",
          name: "API",
          type: "api",
          groupIds: ["group-a"],
          supportedModelIds: ["sora-2"],
          contentSafetyEnabled: true,
          isEnabled: true,
          alwaysActive: false,
          failureCooldownEnabled: true,
          priority: 0,
          concurrency: 1,
          status: "active",
          healthStatus: "healthy",
          inflightCount: 0,
          leaseAcquiredCount: 0,
          createdAt: "2026-08-20T00:00:00.000Z",
          lastAcquiredAt: null,
          lastUsedAt: null,
          lastError: null,
          lastErrorAt: null,
          config: {
            baseUrl: "https://example.com",
            hasApiKey: true,
            useStream: false,
            videoSubmissionRetryCount: 2,
            videoProtocolMode: "gemini",
            videoInputCapabilities: {
              referenceVideos: true,
              referenceAudios: true,
            },
            modelMappings: [],
          },
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("人工号池列表使用独立严格分页契约且不向 Agent 暴露", () => {
    expect(
      adminPoolMemberListInputSchema.safeParse({
        timeZone: "Asia/Shanghai",
      }).success
    ).toBe(true);
    expect(
      adminPoolMemberListInputSchema.safeParse({
        page: 2,
        pageSize: 50,
        name: "api",
        credentialStatus: "not_applicable",
        modelId: "gpt-image-2",
        createdFrom: "2026-08-01",
        createdTo: "2026-08-13",
        timeZone: "Asia/Shanghai",
      }).success
    ).toBe(true);
    expect(
      adminPoolMemberListInputSchema.safeParse({
        pageSize: 30,
        timeZone: "Invalid/TimeZone",
      }).success
    ).toBe(false);
    expect(adminPoolGroupListInputSchema.safeParse({}).success).toBe(true);
    for (const operation of [listAdminMembers, listAdminGroups]) {
      expect(operation.readOnly).toBe(true);
      expect(operation.agentExposure).toBe("human-only");
      expect(operation.idempotency).toEqual({ kind: "natural" });
      expect(operation.sideEffects).toEqual([]);
    }
  });

  it("pool.saveGroup 接受真实分组字段和稀疏图像价格覆盖", () => {
    expect(
      saveGroup.input.safeParse({
        ...validGroup,
        imageCreditOverrides: {
          version: 1,
          byModel: { "custom-image-v3": { base2kCredits: 6 } },
        },
        videoCreditOverrides: { sora2: 42 },
        videoCreditsPerItemOverrides: { "sora2@1080p": 5 },
      }).success
    ).toBe(true);
    expect(saveGroup.agentExposure).toBe("human-only");
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
    expect(
      saveGroup.input.safeParse({
        ...validGroup,
        videoCreditsPerItemOverrides: { "sora2@1080p": 0 },
      }).success
    ).toBe(false);
    expect(
      saveGroup.input.safeParse({
        ...validGroup,
        videoBillingModes: { sora2: "per_item" },
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
          modelMappings: [],
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

  it("供应商账号输入不接受模型计费模式或金额", () => {
    const member = {
      type: "api" as const,
      name: "API",
      groupIds: ["group-a"],
      supportedModelIds: ["sora-2"],
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      failureCooldownEnabled: false,
      priority: 0,
      concurrency: 1,
      config: {
        baseUrl: "https://example.com",
        modelMappings: [],
      },
    };

    for (const pricingField of [
      { videoCreditOverrides: { "sora-2@1080p": 30 } },
      { videoCreditsPerItemOverrides: { "sora-2@1080p": 3 } },
      { videoBillingModes: { "sora-2": "per_item" } },
    ]) {
      expect(
        saveMember.input.safeParse({ ...member, ...pricingField }).success
      ).toBe(false);
    }
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
          modelMappings: [],
        },
      }).success
    ).toBe(true);
    expect(
      deleteMember.input.safeParse({ id: "member-a", memberType: "api" })
        .success
    ).toBe(false);
  });

  it("移除旧参数映射输入与模板操作", () => {
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
          modelMappings: [],
          parameterMappings: [],
        },
      }).success
    ).toBe(false);
    expect(getOperation("pool.listParameterMappingTemplates")).toBeUndefined();
    expect(getOperation("pool.saveParameterMappingTemplate")).toBeUndefined();
    expect(getOperation("pool.deleteParameterMappingTemplate")).toBeUndefined();
  });

  it("成员状态重置只接受统一成员 ID 且声明为自然幂等", () => {
    expect(resetMemberStatus.input.safeParse({ id: "member-a" }).success).toBe(
      true
    );
    expect(
      resetMemberStatus.input.safeParse({
        id: "member-a",
        credentialStatus: "active",
      }).success
    ).toBe(false);
    expect(resetMemberStatus.readOnly).toBe(false);
    expect(resetMemberStatus.destructive).toBe(false);
    expect(resetMemberStatus.idempotency).toEqual({ kind: "natural" });
  });

  it("成员启用开关使用最小输入并声明为自然幂等写操作", () => {
    expect(
      setMemberEnabled.input.safeParse({
        id: "member-a",
        isEnabled: false,
      }).success
    ).toBe(true);
    expect(
      setMemberEnabled.input.safeParse({
        id: "member-a",
        isEnabled: false,
        memberType: "api",
      }).success
    ).toBe(false);
    expect(setMemberEnabled.readOnly).toBe(false);
    expect(setMemberEnabled.destructive).toBe(false);
    expect(setMemberEnabled.idempotency).toEqual({ kind: "natural" });
    expect(setMemberEnabled.sideEffects).toEqual(["audit"]);
  });

  it("API 适配脚本测试与运行诊断是仅限人工的进程内 UOL operation", () => {
    expect(
      testApiUpstreamAdapter.input.safeParse({
        operation: "videos.generate",
        stage: "request",
        script: "return {};",
        sample: { model: "seedance2" },
      }).success
    ).toBe(true);
    expect(testApiUpstreamAdapter.readOnly).toBe(true);
    expect(testApiUpstreamAdapter.idempotency).toEqual({ kind: "natural" });
    expect(testApiUpstreamAdapter.sideEffects).toEqual(["queue"]);
    expect(testApiUpstreamAdapter.agentExposure).toBe("human-only");
    expect(testApiUpstreamAdapter.processLocalState).toBe(true);

    expect(getApiUpstreamRuntimeDiagnostics.input.safeParse({}).success).toBe(
      true
    );
    expect(getApiUpstreamRuntimeDiagnostics.readOnly).toBe(true);
    expect(getApiUpstreamRuntimeDiagnostics.idempotency).toEqual({
      kind: "natural",
    });
    expect(getApiUpstreamRuntimeDiagnostics.sideEffects).toEqual([]);
    expect(getApiUpstreamRuntimeDiagnostics.agentExposure).toBe("human-only");
    expect(getApiUpstreamRuntimeDiagnostics.processLocalState).toBe(true);
    expect(
      getApiUpstreamRuntimeDiagnostics.output.safeParse({
        lifecycle: "ready",
        workerCount: 1,
        liveWorkerCount: 1,
        requestQueueLength: 0,
        responseQueueLength: 0,
        responsePermitsInUse: 0,
        responsePermitCapacity: 16,
        saturationCount: 0,
        replacementCount: 0,
        script: "must-not-be-exposed",
      }).success
    ).toBe(false);
  });

  it("API 通用管理快照不返回额外凭据诊断字段", () => {
    const member = {
      id: "api-member",
      name: "API",
      type: "api",
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
      createdAt: "2026-07-27T00:00:00.000Z",
      lastAcquiredAt: "2026-07-27T01:00:00.000Z",
      lastUsedAt: "2026-07-27T01:01:00.000Z",
      lastError: "API upstream unavailable",
      lastErrorAt: "2026-07-27T01:02:00.000Z",
      config: {
        baseUrl: "https://api.example.com/v1",
        hasApiKey: true,
        useStream: false,
        videoSubmissionRetryCount: 2,
        videoProtocolMode: "custom",
        videoInputCapabilities: {
          referenceVideos: false,
          referenceAudios: false,
        },
        videoInputCapabilitiesByModel: {},
        modelMappings: [],
      },
    } as const;
    expect(
      getAdminPool.output.safeParse({ groups: [], members: [member] }).success
    ).toBe(true);
    expect(
      getAdminPool.output.safeParse({
        groups: [],
        members: [{ ...member, credentialHealthStatus: "healthy" }],
      }).success
    ).toBe(false);
    expect(
      getAdminPool.output.safeParse({
        groups: [],
        members: [
          {
            ...member,
            videoCreditsPerItemOverrides: { "sora2@720p": 3 },
          },
        ],
      }).success
    ).toBe(false);
    for (const forbiddenField of ["apiKey", "headers", "rawError"]) {
      expect(
        getAdminPool.output.safeParse({
          groups: [],
          members: [
            {
              ...member,
              config: {
                ...member.config,
                [forbiddenField]: "must-not-cross-uol",
              },
            },
          ],
        }).success
      ).toBe(false);
    }
    expect(
      getAdminPool.output.safeParse({
        groups: [],
        members: [
          {
            ...member,
            config: {
              ...member.config,
              apiKey: "secret-must-not-cross-uol",
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
