/**
 * 模型广场 DB-free 目录规则测试。
 *
 * 锁定图像与视频模型身份、最低价、默认展示、支持参数排序和幂等回执清理的唯一解释，
 * 防止管理清单与公开页面产生不同结果。
 */
import { describe, expect, it } from "vitest";
import {
  getMinimumImageCredits,
  isModelMarketplaceEntryVisible,
  normalizeModelMarketplaceImageConfigKey,
  pruneModelMarketplaceWriteReceipts,
  resolveModelMarketplaceEntry,
  resolveModelMarketplaceVideoFamily,
  sortUniqueAspectRatios,
  sortUniqueDurations,
  sortUniqueVideoResolutions,
} from "./catalog";
import type { ModelMarketplaceWriteReceipt } from "./contracts";

describe("模型身份规则", () => {
  it("复用计费规则规范化图像模型别名", () => {
    expect(
      normalizeModelMarketplaceImageConfigKey("  Firefly-GPT-Image-2  ")
    ).toBe("gpt-image-2");
    expect(normalizeModelMarketplaceImageConfigKey("GEMINI-2.5-FLASH")).toBe(
      "gemini-2.5-flash"
    );
    expect(normalizeModelMarketplaceImageConfigKey("  ")).toBeNull();
  });

  it.each([
    "veo31",
    "kling3-omni",
    "runway-gen45",
    "ray314",
    "ray314-hdr",
    "kling-o3",
  ])("只接受真实视频模型 ID %s", (modelId) => {
    expect(resolveModelMarketplaceVideoFamily(modelId)).toBe(modelId);
  });

  it.each([
    "firefly-veo31",
    "firefly-veo31-4s-16x9-1080p",
    "kling3-omni-3s-16x9-1080p",
    "runway-gen45-5s-16x9",
    "ray314-hdr-5s-16x9-4k",
    "unknown-video-4s-16x9",
  ])("拒绝前缀、复合或未知视频模型 ID %s", (modelId) => {
    expect(resolveModelMarketplaceVideoFamily(modelId)).toBeNull();
  });
});

describe("目录展示与价格规则", () => {
  it("取图像四档完整价格中的最低值", () => {
    expect(
      getMinimumImageCredits({
        base1024Credits: 3,
        base1kCredits: 1.27,
        base2kCredits: 5.07,
        base4kCredits: 10,
      })
    ).toBe(1.27);
  });

  it("缺少显式配置时保留图像首页展示并默认关闭视频首页展示", () => {
    const first = resolveModelMarketplaceEntry(undefined, "image");
    const second = resolveModelMarketplaceEntry(undefined, "image");
    const video = resolveModelMarketplaceEntry(undefined, "video");

    expect(first).toEqual({
      revision: 0,
      visible: true,
      homepageVisible: true,
      homepagePriority: 5,
      description: "",
      cover: null,
    });
    expect(first).not.toBe(second);
    expect(video).toMatchObject({
      visible: true,
      homepageVisible: false,
      homepagePriority: 5,
    });
    expect(
      isModelMarketplaceEntryVisible(undefined, "image", "new-model")
    ).toBe(true);
  });

  it("尊重显式关闭且保证 default 永不公开", () => {
    const hidden = {
      revision: 1,
      visible: false,
      description: "",
      cover: null,
    };

    expect(isModelMarketplaceEntryVisible(hidden, "image", "gpt-image-2")).toBe(
      false
    );
    expect(isModelMarketplaceEntryVisible(undefined, "image", "default")).toBe(
      false
    );
  });

  it("稳定排序并去重视频支持参数", () => {
    expect(sortUniqueDurations([12, 4, 8, 4])).toEqual([4, 8, 12]);
    expect(sortUniqueAspectRatios(["9:16", "16:9", "9:16", "1:1"])).toEqual([
      "16:9",
      "9:16",
      "1:1",
    ]);
    expect(
      sortUniqueVideoResolutions(["4k", "1080p", "720p", "1080p", "2160p"])
    ).toEqual(["720p", "1080p", "2160p", "4k"]);
  });
});

describe("pruneModelMarketplaceWriteReceipts", () => {
  /** 构造合法回执，便于测试只关注清理时间和稳定顺序。 */
  function createReceipt(
    completedAt: string,
    resultingRevision: number
  ): ModelMarketplaceWriteReceipt {
    return {
      requestHash: resultingRevision.toString(16).padStart(64, "0"),
      category: "image",
      configKey: "gpt-image-2",
      resultingRevision,
      completedAt,
    };
  }

  it("删除达到 24 小时的回执", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const receipts = {
      ["1".padStart(64, "0")]: createReceipt("2026-07-25T12:00:00.000Z", 1),
      ["2".padStart(64, "0")]: createReceipt("2026-07-25T12:00:00.001Z", 2),
    };

    expect(
      Object.keys(pruneModelMarketplaceWriteReceipts(receipts, now))
    ).toEqual(["2".padStart(64, "0")]);
  });

  it("最多保留 256 条最新回执并输出稳定顺序", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const receipts = Object.fromEntries(
      Array.from({ length: 260 }, (_, index) => {
        const completedAt = new Date(
          now.getTime() - (260 - index) * 60_000
        ).toISOString();
        return [
          index.toString(16).padStart(64, "0"),
          createReceipt(completedAt, index),
        ];
      })
    );
    const pruned = pruneModelMarketplaceWriteReceipts(receipts, now);

    expect(Object.keys(pruned)).toHaveLength(256);
    expect(Object.keys(pruned)[0]).toBe("4".padStart(64, "0"));
    expect(Object.keys(pruned).at(-1)).toBe("103".padStart(64, "0"));
  });
});
