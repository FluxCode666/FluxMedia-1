/**
 * 统一媒体后端成员契约测试。
 *
 * 职责：验证 API、Adobe gateway 与 Adobe direct 使用同一严格成员输入，且
 * 空模型能力、类型字段混用和不可执行的视频声明会在保存前失败。
 */
import { describe, expect, it } from "vitest";

import { backendMemberInputSchema } from "./member-contract";

const commonMember = {
  name: "媒体后端",
  groupIds: ["group-a"],
  supportedModelIds: ["gpt-image-2"],
  contentSafetyEnabled: true,
  isEnabled: true,
  alwaysActive: false,
  failureCooldownEnabled: true,
  priority: 10,
  concurrency: 2,
};

describe("backend member contract", () => {
  it("accepts strict API media configuration", () => {
    const parsed = backendMemberInputSchema.safeParse({
      ...commonMember,
      type: "api",
      config: {
        baseUrl: "https://images.example.com/v1",
        apiKey: "secret",
        useStream: true,
        parameterMappings: [],
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "api") {
      expect(parsed.data.config.useStream).toBe(true);
    }
  });

  it("defaults API image streaming to disabled", () => {
    const parsed = backendMemberInputSchema.parse({
      ...commonMember,
      type: "api",
      config: {
        baseUrl: "https://images.example.com/v1",
        parameterMappings: [],
      },
    });
    expect(parsed.type).toBe("api");
    if (parsed.type === "api") expect(parsed.config.useStream).toBe(false);
  });

  it("allows HTTP and private-network media upstream URLs", () => {
    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        type: "api",
        config: {
          baseUrl: "http://10.0.0.8:8080/v1",
          parameterMappings: [],
        },
      }).success
    ).toBe(true);
    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        type: "adobe",
        config: {
          mode: "gateway",
          baseUrl: "http://127.0.0.1:8080/v1",
          defaultRatio: "1:1",
          defaultResolution: "2k",
          gptImageQuality: "high",
        },
      }).success
    ).toBe(true);
  });

  it.each([
    "gateway",
    "direct",
  ] as const)("accepts strict Adobe %s configuration", (mode) => {
    const config =
      mode === "gateway"
        ? {
            mode,
            baseUrl: "https://firefly.example.com/v1",
            apiKey: "secret",
            defaultRatio: "1:1",
            defaultResolution: "2k",
            gptImageQuality: "high" as const,
          }
        : {
            mode,
            cookie: "cookie-secret",
            defaultRatio: "1:1",
            defaultResolution: "2k",
            gptImageQuality: "high" as const,
          };

    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        type: "adobe",
        config,
      }).success
    ).toBe(true);
  });

  it("requires one direct credential on creation and allows an omitted secret on edit", () => {
    const directConfig = {
      mode: "direct" as const,
      defaultRatio: "1:1",
      defaultResolution: "2k",
      gptImageQuality: "high" as const,
    };
    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        type: "adobe",
        config: directConfig,
      }).success
    ).toBe(false);
    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        id: "direct-existing",
        type: "adobe",
        config: directConfig,
      }).success
    ).toBe(true);
  });

  it("rejects empty capabilities and mixed type-specific fields", () => {
    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        supportedModelIds: [],
        type: "api",
        config: {
          baseUrl: "https://images.example.com/v1",
          parameterMappings: [],
        },
      }).success
    ).toBe(false);

    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        supportedModelIds: [],
        type: "adobe",
        config: {
          mode: "direct",
          cookie: "cookie-secret",
          defaultRatio: "1:1",
          defaultResolution: "2k",
          gptImageQuality: "high",
        },
      }).success
    ).toBe(false);

    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        type: "api",
        config: {
          baseUrl: "https://images.example.com/v1",
          parameterMappings: [],
          mode: "gateway",
        },
      }).success
    ).toBe(false);

    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        type: "adobe",
        config: {
          mode: "direct",
          cookie: "cookie-secret",
          parameterMappings: [],
          defaultRatio: "1:1",
          defaultResolution: "2k",
          gptImageQuality: "high",
        },
      }).success
    ).toBe(false);
  });

  it("只允许 API 与 Adobe direct 成员声明真实视频模型 ID", () => {
    const videoMember = {
      ...commonMember,
      supportedModelIds: ["seedance2"],
    };

    expect(
      backendMemberInputSchema.safeParse({
        ...videoMember,
        type: "adobe",
        config: {
          mode: "direct",
          cookie: "cookie-secret",
          defaultRatio: "16:9",
          defaultResolution: "720p",
          gptImageQuality: "high",
        },
      }).success
    ).toBe(true);
    expect(
      backendMemberInputSchema.safeParse({
        ...videoMember,
        type: "adobe",
        config: {
          mode: "gateway",
          baseUrl: "https://firefly.example.com/v1",
          defaultRatio: "16:9",
          defaultResolution: "720p",
          gptImageQuality: "high",
        },
      }).success
    ).toBe(false);
    expect(
      backendMemberInputSchema.safeParse({
        ...videoMember,
        type: "api",
        config: {
          baseUrl: "https://images.example.com/v1",
          parameterMappings: [],
        },
      }).success
    ).toBe(true);
  });

  it.each([
    "firefly-seedance2",
    "firefly-seedance2-15s-9x16-480p",
    "seedance2-15s-9x16-480p",
    "seedance2-preview",
    "kling3-10s-16x9",
  ])("拒绝旧视频身份 %s", (modelId) => {
    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        id: "direct-existing",
        supportedModelIds: [modelId],
        type: "adobe",
        config: {
          mode: "direct",
          defaultRatio: "16:9",
          defaultResolution: "720p",
          gptImageQuality: "high",
        },
      }).success
    ).toBe(false);
  });

  it("rejects unknown legacy identity and interface fields", () => {
    for (const legacyField of [
      ["adobe", "Sourced"].join(""),
      "interfaceMode",
      "imagesUpstreamMode",
      "chatCompletionsUpstreamMode",
    ]) {
      expect(
        backendMemberInputSchema.safeParse({
          ...commonMember,
          type: "api",
          config: {
            baseUrl: "https://images.example.com/v1",
            parameterMappings: [],
          },
          [legacyField]: true,
        }).success
      ).toBe(false);
    }
  });
});
