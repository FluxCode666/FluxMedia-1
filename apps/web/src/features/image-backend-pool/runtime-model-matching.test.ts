/**
 * 统一媒体调度模型规范化测试。
 *
 * 职责：锁定视频只按真实 ID 精确匹配且图像模型语义不变，避免调度层重新解析参数或
 * 供应商前缀。
 */
import { describe, expect, it } from "vitest";

import { normalizeRuntimeRequestedModelId } from "./runtime-model-matching";

describe("normalizeRuntimeRequestedModelId", () => {
  it("视频只接受规范大小写后的真实模型 ID", () => {
    expect(
      normalizeRuntimeRequestedModelId({
        requestKind: "video",
        modelId: " SEEDANCE2 ",
      })
    ).toBe("seedance2");
    expect(
      normalizeRuntimeRequestedModelId({
        requestKind: "video",
        modelId: "seedance2-fast",
      })
    ).toBe("seedance2-fast");
  });

  it.each([
    "firefly-seedance2",
    "firefly-seedance2-15s-9x16-480p",
    "seedance2-15s-9x16-480p",
    "kling3-10s-16x9",
    "seedance2-preview",
  ])("视频拒绝旧身份或目录外变体 %s", (modelId) => {
    expect(
      normalizeRuntimeRequestedModelId({ requestKind: "video", modelId })
    ).toBeNull();
  });

  it("图像继续接受 trim 后的真实上游模型 ID", () => {
    expect(
      normalizeRuntimeRequestedModelId({
        requestKind: "image",
        modelId: " firefly-gpt-image-2 ",
      })
    ).toBe("firefly-gpt-image-2");
  });
});
