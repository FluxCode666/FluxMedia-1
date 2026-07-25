/**
 * 外部媒体模型目录纯函数测试。
 *
 * 职责：锁定大小写无关去重，确保旧对话模型辅助函数不再成为公开 API。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  getPlanCapabilitySnapshot: vi.fn(),
}));

import { mergeExternalModelIds } from "./models";

describe("mergeExternalModelIds", () => {
  it("按首次出现顺序去重统一成员显式模型", () => {
    expect(
      mergeExternalModelIds(
        ["gpt-image-2"],
        ["firefly-sora2-8s-16x9", "GROK-IMAGINE-IMAGE"],
        ["grok-imagine-image", "  gpt-image-2  "]
      )
    ).toEqual(["gpt-image-2", "firefly-sora2-8s-16x9", "GROK-IMAGINE-IMAGE"]);
  });

  it("忽略空模型 ID", () => {
    expect(mergeExternalModelIds(["", "  "], ["gpt-image-2"])).toEqual([
      "gpt-image-2",
    ]);
  });
});
