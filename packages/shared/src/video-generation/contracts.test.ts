/**
 * 视频模型基础契约测试。
 *
 * 覆盖真实模型 ID、公开参数字面量和严格拒绝旧复合身份，确保后续 UOL 与传输层
 * 只能消费同一组 DB-free 运行时 schema。
 */
import { describe, expect, it } from "vitest";

import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODEL_IDS,
  VIDEO_RESOLUTIONS,
  videoAspectRatioSchema,
  videoModelIdSchema,
  videoResolutionSchema,
} from "./contracts";

describe("video generation contracts", () => {
  it("只接受 13 个精确真实模型 ID", () => {
    expect(VIDEO_MODEL_IDS).toEqual([
      "sora2",
      "sora2-pro",
      "veo31",
      "veo31-fast",
      "veo31-ref",
      "kling-o3",
      "kling3",
      "kling3-omni",
      "runway-gen45",
      "ray314",
      "ray314-hdr",
      "seedance2",
      "seedance2-fast",
    ]);
    for (const modelId of VIDEO_MODEL_IDS) {
      expect(videoModelIdSchema.parse(modelId)).toBe(modelId);
    }
  });

  it.each([
    "firefly-seedance2",
    "firefly-seedance2-15s-9x16-480p",
    "seedance2-15s-9x16-480p",
    "kling3-10s-16x9",
    "kling3-10s-16x9-720p",
    "KLING3",
    " seedance2 ",
    "unknown-video-model",
  ])("拒绝旧前缀、复合 ID、历史别名或非精确 ID：%s", (modelId) => {
    expect(videoModelIdSchema.safeParse(modelId).success).toBe(false);
  });

  it("公开参数使用规范 aspectRatio 与小写分辨率", () => {
    expect(VIDEO_ASPECT_RATIOS).toEqual([
      "1:1",
      "4:3",
      "3:4",
      "16:9",
      "9:16",
      "21:9",
    ]);
    expect(VIDEO_RESOLUTIONS).toEqual(["480p", "720p", "1080p", "4k"]);
    expect(videoAspectRatioSchema.parse("16:9")).toBe("16:9");
    expect(videoResolutionSchema.parse("1080p")).toBe("1080p");
    expect(videoAspectRatioSchema.safeParse("16x9").success).toBe(false);
    expect(videoResolutionSchema.safeParse("1080P").success).toBe(false);
    expect(videoResolutionSchema.safeParse("4K").success).toBe(false);
  });
});
