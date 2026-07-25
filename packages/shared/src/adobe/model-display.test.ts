/**
 * Adobe 模型 ID 展示格式化的回归测试。
 *
 * 使用方：共享 Adobe 模型目录与 Web 界面；确保展示层不会改写内部模型 ID。
 */
import { describe, expect, it } from "vitest";

import { formatAdobeModelIdForDisplay } from "./model-display";

describe("formatAdobeModelIdForDisplay", () => {
  it("只移除大小写无关的开头 firefly- 前缀", () => {
    expect(formatAdobeModelIdForDisplay("firefly-nano-banana-pro")).toBe(
      "nano-banana-pro"
    );
    expect(formatAdobeModelIdForDisplay("FIREFLY-veo31-8s-16x9-1080p")).toBe(
      "veo31-8s-16x9-1080p"
    );
  });

  it("保留非 Adobe 前缀与空模型 ID", () => {
    expect(formatAdobeModelIdForDisplay("gpt-image-2")).toBe("gpt-image-2");
    expect(formatAdobeModelIdForDisplay("")).toBe("");
  });
});
