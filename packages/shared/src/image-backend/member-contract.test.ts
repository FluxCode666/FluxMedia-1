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
  it("accepts strict API Images configuration", () => {
    expect(
      backendMemberInputSchema.safeParse({
        ...commonMember,
        type: "api",
        config: {
          baseUrl: "https://images.example.com/v1",
          apiKey: "secret",
          parameterMappings: [],
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
          parameterMappings: [],
          defaultRatio: "1:1",
          defaultResolution: "2k",
          gptImageQuality: "high",
        },
      }).success
    ).toBe(false);
  });

  it("allows video models only on Adobe direct members", () => {
    const videoMember = {
      ...commonMember,
      supportedModelIds: ["firefly-sora2-4s-16x9"],
    };

    expect(
      backendMemberInputSchema.safeParse({
        ...videoMember,
        type: "adobe",
        config: {
          mode: "direct",
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
    ).toBe(false);
  });

  it("rejects unknown legacy identity and interface fields", () => {
    for (const legacyField of [
      "adobeSourced",
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
