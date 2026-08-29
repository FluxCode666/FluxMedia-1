/**
 * 模型配置编辑草稿的 DB-free 单测。
 *
 * 覆盖 DTO 转换、价格收窄、严格 FormData、幂等 UUID 生命周期和 revision 冲突重放；
 * 不发请求、不读取文件字节，也不触达 UOL。
 */
import type { ModelConfigurationEntry } from "@repo/shared/model-marketplace";
import { describe, expect, it } from "vitest";

import {
  buildModelConfigurationFormData,
  createModelConfigurationDraft,
  ModelConfigurationDraftError,
  parseModelConfigurationHomepagePriority,
  parseModelConfigurationPrice,
  rebaseModelConfigurationDraft,
  renewModelConfigurationDraftRequestId,
} from "./model-configuration-draft";

const IMAGE_ENTRY: Extract<
  ModelConfigurationEntry,
  { category: "image"; pricingSource: "explicit" }
> = {
  category: "image",
  configKey: "gpt-image-2",
  displayName: "GPT Image 2",
  iconKey: "openai",
  revision: 2,
  marketplaceApplicable: true,
  enabled: true,
  visible: true,
  homepageVisible: true,
  homepagePriority: 3,
  description: "精细图像生成",
  coverUrl: "/model-marketplace/default-image.webp",
  usesDefaultCover: true,
  minimumCredits: 1.27,
  pricingSource: "explicit",
  pricing: {
    base1024Credits: 1.27,
    base1kCredits: 1.27,
    base2kCredits: 5.07,
    base4kCredits: 10,
  },
  supportsQuality: true,
  supportsAutoSize: true,
};

const UNCONFIGURED_IMAGE_ENTRY: Extract<
  ModelConfigurationEntry,
  { category: "image"; pricingSource: "unconfigured" }
> = {
  category: "image",
  configKey: "vendor-image",
  displayName: "Vendor Image",
  iconKey: "generic",
  revision: 0,
  marketplaceApplicable: true,
  enabled: true,
  visible: true,
  homepageVisible: true,
  homepagePriority: 5,
  description: "",
  coverUrl: "/model-marketplace/default-image.webp",
  usesDefaultCover: true,
  pricingSource: "unconfigured",
};

const VIDEO_ENTRY: Extract<ModelConfigurationEntry, { category: "video" }> = {
  category: "video",
  configKey: "seedance2",
  displayName: "Seedance 2.0",
  iconKey: "bytedance",
  revision: 5,
  marketplaceApplicable: true,
  enabled: false,
  visible: false,
  homepageVisible: false,
  homepagePriority: 8,
  description: "视频模型",
  coverUrl: "/model-marketplace/default-video.webp",
  usesDefaultCover: true,
  minimumCredits: 45,
  billingMode: "per_item",
  creditsPerSecond: 45,
  creditsPerSecondByResolution: { "720p": 30, "1080p": 45 },
  creditsPerItemByResolution: { "720p": 3, "1080p": 5 },
  supportedResolutions: ["720p", "1080p"],
  maxReferenceImages: 20,
};

/** 把 FormData 的标量项转为便于断言的对象，文件保留原实例。 */
function collectFormData(
  formData: FormData
): Record<string, FormDataEntryValue> {
  return Object.fromEntries(formData.entries());
}

describe("模型配置草稿", () => {
  it("按已定价图像、未配置图像和视频创建隔离草稿", () => {
    const image = createModelConfigurationDraft(IMAGE_ENTRY, () => "image-id");
    const unconfigured = createModelConfigurationDraft(
      UNCONFIGURED_IMAGE_ENTRY,
      () => "unconfigured-id"
    );
    const video = createModelConfigurationDraft(VIDEO_ENTRY, () => "video-id");

    expect(image).toMatchObject({
      category: "image",
      clientRequestId: "image-id",
      expectedRevision: 2,
      pricing: { base4kCredits: "10" },
      cover: { action: "keep", file: null },
    });
    expect(unconfigured).toMatchObject({
      category: "image",
      clientRequestId: "unconfigured-id",
      pricing: {
        base1024Credits: "",
        base1kCredits: "",
        base2kCredits: "",
        base4kCredits: "",
        base8kCredits: "",
      },
    });
    expect(video).toMatchObject({
      category: "video",
      clientRequestId: "video-id",
      billingMode: "per_item",
      creditsPerSecondByResolution: { "720p": "30", "1080p": "45" },
      creditsPerItemByResolution: { "720p": "3", "1080p": "5" },
      maxReferenceImages: "20",
      enabled: false,
      visible: false,
      homepageVisible: false,
      homepagePriority: "8",
    });
  });

  it.each([
    ["0", 0],
    ["5", 5],
    ["10000", 10_000],
  ])("解析合法首页优先级 %s", (input, expected) => {
    expect(parseModelConfigurationHomepagePriority(input)).toBe(expected);
  });

  it.each([
    "",
    "-1",
    "1.5",
    "1e2",
    "10001",
    "Infinity",
  ])("拒绝非法首页优先级 %s", (input) => {
    expect(() => parseModelConfigurationHomepagePriority(input)).toThrow(
      ModelConfigurationDraftError
    );
  });

  it.each([
    ["1.27", 1.27],
    [" 10 ", 10],
    ["0.0001", 0.0001],
  ])("解析合法价格 %s", (input, expected) => {
    expect(parseModelConfigurationPrice(input)).toBe(expected);
  });

  it.each([
    "",
    "0",
    "-1",
    "+1",
    "1e3",
    "NaN",
    "Infinity",
    "1,2",
  ])("拒绝非法价格 %s", (input) => {
    expect(() => parseModelConfigurationPrice(input)).toThrow(
      ModelConfigurationDraftError
    );
  });

  it("图像 FormData 只包含当前联合分支字段", () => {
    const draft = createModelConfigurationDraft(IMAGE_ENTRY, () => "image-id");
    const values = collectFormData(buildModelConfigurationFormData(draft));

    expect(values).toEqual({
      category: "image",
      configKey: "gpt-image-2",
      expectedRevision: "2",
      clientRequestId: "image-id",
      enabled: "true",
      visible: "true",
      homepageVisible: "true",
      iconKey: "openai",
      homepagePriority: "3",
      description: "精细图像生成",
      coverChange: "keep",
      supportsQuality: "true",
      supportsAutoSize: "true",
      base1024Credits: "1.27",
      base1kCredits: "1.27",
      base2kCredits: "5.07",
      base4kCredits: "10",
    });
  });

  it("视频 replace 引用唯一文件", () => {
    const file = new File([new Uint8Array([1, 2])], "cover.png", {
      type: "image/png",
    });
    const video = createModelConfigurationDraft(VIDEO_ENTRY, () => "video-id");
    if (video.category !== "video") throw new Error("预期视频草稿");
    const videoValues = collectFormData(
      buildModelConfigurationFormData({
        ...video,
        cover: { action: "replace", file },
      })
    );
    expect(videoValues.cover).toBe(file);
    expect(videoValues.coverChange).toBe("replace");
    expect(videoValues.creditsPerSecondByResolution).toBe(
      JSON.stringify({ "1080p": 45, "720p": 30 })
    );
    expect(videoValues.billingMode).toBe("per_item");
    expect(videoValues.creditsPerItemByResolution).toBe(
      JSON.stringify({ "720p": 3, "1080p": 5 })
    );
    expect(videoValues.supportedResolutions).toBe(
      JSON.stringify(["720p", "1080p"])
    );
    expect(videoValues.maxReferenceImages).toBe("20");
  });

  it("网络重试复用 UUID，修改草稿才生成新 UUID", () => {
    const original = createModelConfigurationDraft(IMAGE_ENTRY, () => "id-1");
    expect(
      buildModelConfigurationFormData(original).get("clientRequestId")
    ).toBe("id-1");
    expect(
      buildModelConfigurationFormData(original).get("clientRequestId")
    ).toBe("id-1");

    const changed = renewModelConfigurationDraftRequestId(
      original,
      () => "id-2"
    );
    expect(changed.clientRequestId).toBe("id-2");
    expect(original.clientRequestId).toBe("id-1");
  });

  it("冲突重放保留草稿并更新 revision 与 UUID", () => {
    const original = createModelConfigurationDraft(IMAGE_ENTRY, () => "id-1");
    if (original.category !== "image") throw new Error("预期图像草稿");
    const changed = {
      ...original,
      description: "本地尚未保存的简介",
      pricing: { ...original.pricing, base4kCredits: "12" },
      cover: { action: "remove", file: null } as const,
    };
    const latest: typeof IMAGE_ENTRY = {
      ...IMAGE_ENTRY,
      revision: 9,
    };

    const rebased = rebaseModelConfigurationDraft(
      changed,
      latest,
      () => "id-2"
    );

    expect(rebased).toMatchObject({
      expectedRevision: 9,
      clientRequestId: "id-2",
      description: "本地尚未保存的简介",
      pricing: { base4kCredits: "12" },
      cover: { action: "remove" },
    });
  });

  it("拒绝把冲突草稿串到另一模型", () => {
    const draft = createModelConfigurationDraft(IMAGE_ENTRY, () => "id-1");
    expect(() =>
      rebaseModelConfigurationDraft(
        draft,
        { ...IMAGE_ENTRY, configKey: "nano-banana" },
        () => "id-2"
      )
    ).toThrow("无法把草稿合并到其他模型");
  });

  it("未配置价格草稿在冲突重放后仍保留本地空价格", () => {
    const draft = createModelConfigurationDraft(
      UNCONFIGURED_IMAGE_ENTRY,
      () => "id-1"
    );
    const latest: Extract<
      ModelConfigurationEntry,
      { category: "image"; pricingSource: "explicit" }
    > = {
      ...IMAGE_ENTRY,
      configKey: "vendor-image",
      revision: 8,
    };

    expect(
      rebaseModelConfigurationDraft(draft, latest, () => "id-2")
    ).toMatchObject({
      expectedRevision: 8,
      pricing: {
        base1024Credits: "",
        base1kCredits: "",
        base2kCredits: "",
        base4kCredits: "",
      },
    });
  });
});
