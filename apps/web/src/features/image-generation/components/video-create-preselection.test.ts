/**
 * 视频创作面板一次性模型初始化的纯函数测试。
 *
 * 使用方是后续 VideoCreatePanel 接入；测试只验证真实视频能力目录到面板初始状态的收窄，
 * 最终用户、后端与模型授权仍必须由生成服务端重新校验。
 */
import { describe, expect, it } from "vitest";

import { resolveVideoInitialSelection } from "../model-preselection";

describe("resolveVideoInitialSelection", () => {
  it("从真实 Veo ID 选择能力目录中的首个合法参数", () => {
    expect(resolveVideoInitialSelection("veo31")).toEqual({
      modelId: "veo31",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "1080p",
    });
  });

  it("从真实 Sora ID 选择能力目录中的首个合法参数", () => {
    expect(resolveVideoInitialSelection("sora2-pro")).toEqual({
      modelId: "sora2-pro",
      duration: 4,
      aspectRatio: "9:16",
      resolution: "720p",
    });
  });

  it("从真实 Runway ID 选择固定 720p 横屏的首个合法时长", () => {
    expect(resolveVideoInitialSelection("runway-gen45")).toEqual({
      modelId: "runway-gen45",
      duration: 5,
      aspectRatio: "16:9",
      resolution: "720p",
    });
  });

  it("从真实 Kling 3.0 ID 选择能力目录中的首个合法参数", () => {
    expect(resolveVideoInitialSelection("kling3")).toEqual({
      modelId: "kling3",
      duration: 3,
      aspectRatio: "16:9",
      resolution: "1080p",
    });
  });

  it("从真实 Ray 3.14 ID 选择能力目录中的首个合法参数", () => {
    expect(resolveVideoInitialSelection("ray314")).toEqual({
      modelId: "ray314",
      duration: 5,
      aspectRatio: "1:1",
      resolution: "4k",
    });
  });

  it("从真实 Ray 3.14 HDR ID 选择能力目录中的首个合法参数", () => {
    expect(resolveVideoInitialSelection("ray314-hdr")).toEqual({
      modelId: "ray314-hdr",
      duration: 5,
      aspectRatio: "1:1",
      resolution: "4k",
    });
  });

  it.each([
    "",
    "firefly-veo31",
    "firefly-veo31-5s-16x9-1080p",
    "veo31-5s-16x9-1080p",
    "firefly-removed-family-8s-16x9",
    "gpt-image-2",
  ])("前缀、复合、非法或非视频模型 %s 返回 null", (modelId) => {
    expect(resolveVideoInitialSelection(modelId)).toBeNull();
  });
});
