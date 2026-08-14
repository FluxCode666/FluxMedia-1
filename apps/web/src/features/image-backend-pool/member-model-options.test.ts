/**
 * 统一号池成员模型选项的 DB-free 测试。
 *
 * 职责：锁定模型配置到真实模型 ID 的映射、成员类型边界与历史能力保留语义。
 */
import { ADOBE_VIDEO_PRICING_FAMILIES } from "@repo/shared/adobe";
import { createDefaultApiUpstreamOperations } from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  type BackendMemberInput,
  backendMemberInputSchema,
} from "@repo/shared/image-backend/member-contract";
import type {
  ModelConfigurationEntry,
  ModelConfigurationSnapshot,
} from "@repo/shared/model-marketplace";
import { VIDEO_MODEL_CAPABILITY_CATALOG } from "@repo/shared/video-generation";
import { describe, expect, it } from "vitest";

import {
  acceptsVideoBackendMemberModels,
  buildBackendMemberModelOptions,
  DEFAULT_ADOBE_MEMBER_MODE,
  findUnavailableBackendMemberModelIds,
  normalizeBackendMemberModelIdsForDisplay,
  removeVideoBackendMemberModelIds,
} from "./member-model-options";

const commonEntry = {
  revision: 0,
  marketplaceApplicable: true as const,
  enabled: true,
  visible: true,
  homepageVisible: true,
  homepagePriority: 5,
  description: "",
  coverUrl: null,
  usesDefaultCover: true,
};

describe("账号形态视频能力", () => {
  it("API 与 Adobe Direct 开放视频模型，Adobe Gateway 不开放", () => {
    expect(DEFAULT_ADOBE_MEMBER_MODE).toBe("direct");
    expect(
      acceptsVideoBackendMemberModels("adobe", DEFAULT_ADOBE_MEMBER_MODE)
    ).toBe(true);
    expect(acceptsVideoBackendMemberModels("adobe", "gateway")).toBe(false);
    expect(acceptsVideoBackendMemberModels("api", "direct")).toBe(true);
  });
});

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
    creditsPerSecondByResolution: { "720p": 45, "1080p": 45 },
    supportedResolutions: ["720p", "1080p"],
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
        videoSubmissionRetryCount: 2,
        modelMappings: [],
        authentication: { mode: "bearer" },
        operations: createDefaultApiUpstreamOperations(),
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
  it("保留图像配置键且每个视频模型只生成一个真实 ID", () => {
    const options = buildBackendMemberModelOptions(snapshot);

    expect(options).toContainEqual({
      id: "gpt-image-2",
      label: "GPT Image 2",
      category: "image",
      source: "model_configuration",
    });
    expect(options).toContainEqual({
      id: "veo31",
      label: "Veo 3.1",
      category: "video",
      source: "model_configuration",
      supportedResolutions: ["720p", "1080p"],
    });
    expect(options.filter((option) => option.category === "video")).toEqual([
      {
        id: "veo31",
        label: "Veo 3.1",
        category: "video",
        source: "model_configuration",
        supportedResolutions: ["720p", "1080p"],
      },
    ]);
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

  it("一个 Seedance 成员能力承接该模型全部全局合法参数与互斥输入模式", () => {
    const seedanceEntry: ModelConfigurationEntry = {
      ...commonEntry,
      category: "video",
      configKey: "seedance2",
      displayName: "Seedance 2.0",
      iconKey: "generic",
      minimumCredits: 30,
      creditsPerSecond: 30,
      creditsPerSecondByResolution: {
        "480p": 30,
        "720p": 30,
        "1080p": 30,
      },
      supportedResolutions: ["480p", "720p", "1080p"],
    };
    const options = buildBackendMemberModelOptions({
      ...snapshot,
      entries: [seedanceEntry],
    });

    expect(options).toEqual([
      {
        id: "seedance2",
        label: "Seedance 2.0",
        category: "video",
        source: "model_configuration",
        supportedResolutions: ["480p", "720p", "1080p"],
      },
    ]);
    expect(
      findUnavailableBackendMemberModelIds(
        createMemberInput(["seedance2"], true),
        options
      )
    ).toEqual([]);
    expect(VIDEO_MODEL_CAPABILITY_CATALOG.seedance2).toMatchObject({
      durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
      resolutions: ["1080p", "720p", "480p"],
      input: {
        frames: "first-and-optional-last",
        referenceImages: { maxCount: 10, configurable: true },
        framesAndReferencesMutuallyExclusive: true,
      },
    });
  });

  it("自定义视频模型保留管理类别与分辨率并进入账号选项", () => {
    const customVideoEntry: ModelConfigurationEntry = {
      ...commonEntry,
      category: "video",
      configKey: "vendor-video-x",
      displayName: "Vendor Video X",
      iconKey: "generic",
      minimumCredits: 30,
      creditsPerSecond: 30,
      creditsPerSecondByResolution: { "720p": 30, "1080p": 45 },
      supportedResolutions: ["720p", "1080p"],
    };

    const options = buildBackendMemberModelOptions({
      ...snapshot,
      entries: [customVideoEntry],
    });
    expect(options).toEqual([
      {
        id: "vendor-video-x",
        label: "Vendor Video X",
        category: "video",
        source: "model_configuration",
        supportedResolutions: ["720p", "1080p"],
      },
    ]);
    expect(
      findUnavailableBackendMemberModelIds(
        createMemberInput(["vendor-video-x"], false),
        options
      )
    ).toEqual([]);
    expect(
      findUnavailableBackendMemberModelIds(
        createMemberInput(["vendor-video-x"], true),
        options
      )
    ).toEqual(["vendor-video-x"]);
  });

  it("当前全部视频模型各生成一个选项并可由 Adobe direct 成员一次全选保存", () => {
    const videoEntries: ModelConfigurationEntry[] =
      ADOBE_VIDEO_PRICING_FAMILIES.map((configKey) => ({
        ...commonEntry,
        category: "video",
        configKey,
        displayName: configKey,
        iconKey: "generic",
        minimumCredits: 30,
        creditsPerSecond: 30,
        creditsPerSecondByResolution: { "720p": 30 },
        supportedResolutions: ["720p"],
      }));
    const options = buildBackendMemberModelOptions({
      ...snapshot,
      entries: [imageEntry, ...videoEntries],
    });

    expect(
      options.filter((option) => option.category === "video")
    ).toHaveLength(videoEntries.length);
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
  const videoModelId = "veo31";

  it("API 成员可以保存模型配置中的图片与真实视频 ID", () => {
    expect(
      findUnavailableBackendMemberModelIds(
        createMemberInput(
          ["gpt-image-2", videoModelId, "unknown-model"],
          false
        ),
        options
      )
    ).toEqual(["unknown-model"]);
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

  it.each([
    "firefly-seedance2",
    "firefly-seedance2-15s-9x16-480p",
    "seedance2-15s-9x16-480p",
    "seedance2-preview",
    "kling3-10s-16x9",
  ])("编辑成员不能用 existing-member 放行旧视频身份 %s", (modelId) => {
    expect(
      findUnavailableBackendMemberModelIds(
        createMemberInput([modelId], true),
        options,
        [modelId]
      )
    ).toEqual([modelId]);
  });
});

describe("normalizeBackendMemberModelIdsForDisplay", () => {
  it("账号池卡片只展示真实视频 ID 且保持图像兼容行为", () => {
    expect(
      normalizeBackendMemberModelIdsForDisplay([
        "SEEDANCE2",
        "seedance2",
        "firefly-seedance2-15s-9x16-480p",
        "seedance2-preview",
        "firefly-gpt-image-2",
      ])
    ).toEqual(["seedance2", "gpt-image-2"]);
  });
});

describe("removeVideoBackendMemberModelIds", () => {
  it("切离 Adobe Direct 时只清理真实与旧复合视频 ID", () => {
    expect(
      removeVideoBackendMemberModelIds([
        "gpt-image-2",
        "seedance2",
        "firefly-seedance2-15s-9x16-480p",
        "custom-image-model",
      ])
    ).toEqual(["gpt-image-2", "custom-image-model"]);
  });
});
