/** Adobe 图片适配器模型家族解析测试。 */
import { describe, expect, it } from "vitest";

import { pickAdobeFamilyFromModel } from "./adobe-model-family";

describe("pickAdobeFamilyFromModel", () => {
  it("按最长前缀解析 Firefly 与裸 Nano Banana 家族", () => {
    expect(pickAdobeFamilyFromModel("firefly-nano-banana-pro-2k-1x1")).toBe(
      "nano-banana-pro"
    );
    expect(pickAdobeFamilyFromModel("firefly-gpt-image-2")).toBe("gpt-image-2");
    expect(pickAdobeFamilyFromModel("nano-banana2-2k-1x1")).toBe(
      "nano-banana2"
    );
  });

  it("对非 Adobe 图片能力返回 null", () => {
    expect(pickAdobeFamilyFromModel("gpt-image-1")).toBeNull();
    expect(pickAdobeFamilyFromModel("firefly-unknown")).toBeNull();
  });
});
