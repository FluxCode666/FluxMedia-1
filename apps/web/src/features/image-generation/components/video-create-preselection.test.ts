/**
 * 视频创作面板一次性模型初始化的纯函数测试。
 *
 * 使用方是后续 VideoCreatePanel 接入；测试只验证静态 Firefly 目录到面板初始状态的收窄，
 * 最终用户、后端与模型授权仍必须由生成服务端重新校验。
 */
import { describe, expect, it } from "vitest";

import { resolveVideoInitialSelection } from "../model-preselection";

describe("resolveVideoInitialSelection", () => {
  it("把完整 Veo 模型 ID 转换为面板族、时长、比例和分辨率", () => {
    expect(resolveVideoInitialSelection("firefly-veo31-6s-9x16-1080p")).toEqual(
      {
        familyId: "veo31",
        duration: 6,
        ratio: "9:16",
        resolution: "1080p",
      }
    );
  });

  it("对不在 ID 中携带分辨率的 Sora 使用静态目录安全值", () => {
    expect(resolveVideoInitialSelection("firefly-sora2-pro-12s-16x9")).toEqual({
      familyId: "sora2-pro",
      duration: 12,
      ratio: "16:9",
      resolution: "720p",
    });
  });

  it("对 Runway Gen-4.5 预选固定 720p 横屏和 ID 中的时长", () => {
    expect(
      resolveVideoInitialSelection("firefly-runway-gen45-8s-16x9")
    ).toEqual({
      familyId: "runway-gen45",
      duration: 8,
      ratio: "16:9",
      resolution: "720p",
    });
  });

  it("对 Ray 3.14 预选 ID 中的时长、比例和 4k 分辨率", () => {
    expect(resolveVideoInitialSelection("firefly-ray314-10s-21x9-4k")).toEqual({
      familyId: "ray314",
      duration: 10,
      ratio: "21:9",
      resolution: "4k",
    });
  });

  it.each([
    "",
    "firefly-veo31-5s-16x9-1080p",
    "firefly-removed-family-8s-16x9",
    "gpt-image-2",
  ])("非法、已移除或非视频模型 %s 返回 null", (modelId) => {
    expect(resolveVideoInitialSelection(modelId)).toBeNull();
  });
});
