/**
 * 统一号池成员模型选项的 DB-free 测试。
 *
 * 职责：锁定模型配置到完整调度 ID 的展开、成员类型边界与历史能力保留语义。
 */
import { ADOBE_VIDEO_PRICING_FAMILIES } from "@repo/shared/adobe";
import {
  type BackendMemberInput,
  backendMemberInputSchema,
} from "@repo/shared/image-backend/member-contract";
import type {
  ModelConfigurationEntry,
  ModelConfigurationSnapshot,
} from "@repo/shared/model-marketplace";
import { describe, expect, it } from "vitest";

import {
  buildBackendMemberModelOptions,
  findUnavailableBackendMemberModelIds,
} from "./member-model-options";

const commonEntry = {
  revision: 0,
  marketplaceApplicable: true as const,
  visible: true,
  homepageVisible: true,
  homepagePriority: 5,
  description: "",
  coverUrl: null,
  usesDefaultCover: true,
};

const imageEntry: ModelConfigurationEntry = {
  ...commonEntry,
  category: "image",
  configKey: "gpt-image-2",
  displayName: "GPT Image 2",
  iconKey: "openai",
  pricingSource: "unconfigured",
};

const entries: ModelConfigurationEntry[] = [
  imageEntry,
  {
    ...commonEntry,
    category: "video",
    configKey: "veo31",
    displayName: "Veo 3.1",
    iconKey: "google",
    minimumCredits: 45,
    creditsPerSecond: 45,
  },
];

const snapshot: ModelConfigurationSnapshot = {
  canEdit: false,
  runtimeCatalogStatus: "ready",
  entries,
};

/** 构造只改变模型能力与成员形态的合法公共测试输入。 */
function createMemberInput(
  supportedModelIds: string[],
  direct: boolean
): BackendMemberInput {
  const common = {
    name: "member",
    groupIds: ["group-1"],
    supportedModelIds,
    contentSafetyEnabled: true,
    isEnabled: true,
    alwaysActive: false,
    failureCooldownEnabled: true,
    priority: 50,
    concurrency: 10,
  };
  if (!direct) {
    return {
      ...common,
      type: "api",
      config: {
        baseUrl: "https://api.example.com/v1",
        useStream: false,
        parameterMappings: [],
      },
    };
  }
  return {
    ...common,
    type: "adobe",
    config: {
      mode: "direct",
      cookie: "cookie=value",
      defaultRatio: "1x1",
      defaultResolution: "2k",
      gptImageQuality: "high",
    },
  };
}

describe("buildBackendMemberModelOptions", () => {
  it("保留图像配置键并把视频族展开为真实完整 ID", () => {
    const options = buildBackendMemberModelOptions(snapshot);

    expect(options).toContainEqual({
      id: "gpt-image-2",
      label: "GPT Image 2",
      category: "image",
      source: "model_configuration",
    });
    expect(options).toContainEqual(
      expect.objectContaining({
        id: "veo31-4s-16x9-1080p",
        category: "video",
        source: "model_configuration",
      })
    );
    expect(
      options.filter((option) => option.category === "video").length
    ).toBeGreaterThan(1);
  });

  it("展示开关和运行时目录降级不移除管理能力选项", () => {
    const options = buildBackendMemberModelOptions({
      ...snapshot,
      runtimeCatalogStatus: "unavailable",
      entries: entries.map((entry) => ({ ...entry, visible: false })),
    });

    expect(options.some((option) => option.id === "gpt-image-2")).toBe(true);
    expect(options.some((option) => option.category === "video")).toBe(true);
  });

  it("当前全部视频族展开后仍可由 Adobe direct 成员一次全选保存", () => {
    const videoEntries: ModelConfigurationEntry[] =
      ADOBE_VIDEO_PRICING_FAMILIES.map((configKey) => ({
        ...commonEntry,
        category: "video",
        configKey,
        displayName: configKey,
        iconKey: "generic",
        minimumCredits: 30,
        creditsPerSecond: 30,
      }));
    const options = buildBackendMemberModelOptions({
      ...snapshot,
      entries: [imageEntry, ...videoEntries],
    });

    expect(options.length).toBeGreaterThan(videoEntries.length);
    expect(
      backendMemberInputSchema.safeParse(
        createMemberInput(
          options.map((option) => option.id),
          true
        )
      ).success
    ).toBe(true);
  });
});

describe("findUnavailableBackendMemberModelIds", () => {
  const options = buildBackendMemberModelOptions(snapshot);
  const videoModelId = "veo31-4s-16x9-1080p";

  it("API 成员只能保存模型配置中的图像 ID", () => {
    expect(
      findUnavailableBackendMemberModelIds(
        createMemberInput(
          ["gpt-image-2", videoModelId, "unknown-model"],
          false
        ),
        options
      )
    ).toEqual([videoModelId, "unknown-model"]);
  });

  it("Adobe direct 成员可保存模型配置展开的视频完整 ID", () => {
    expect(
      findUnavailableBackendMemberModelIds(
        createMemberInput(["gpt-image-2", videoModelId], true),
        options
      )
    ).toEqual([]);
  });

  it("编辑时只允许原样保留该成员已有的历史 ID", () => {
    const input = createMemberInput(
      ["legacy-image-model", "new-unknown"],
      false
    );

    expect(
      findUnavailableBackendMemberModelIds(input, options, [
        "legacy-image-model",
      ])
    ).toEqual(["new-unknown"]);
  });
});
