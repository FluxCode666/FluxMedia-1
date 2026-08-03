/**
 * 图片模型 ID 契约的 DB-free 单元测试。
 *
 * 职责：锁定 model 必传、空白归一化与长度边界，防止任何传输入口重新引入隐式
 * 默认模型。
 */
import { describe, expect, it } from "vitest";

import { imageModelIdSchema } from "./model-contract";

describe("imageModelIdSchema", () => {
  it.each([undefined, null, "", "   "])("拒绝缺失或空白值 %s", (model) => {
    const result = imageModelIdSchema.safeParse(model);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("model is required");
    }
  });

  it("去除模型 ID 首尾空白", () => {
    expect(imageModelIdSchema.parse("  gpt-image-2  ")).toBe("gpt-image-2");
  });

  it("不改写目录外模型 ID，由运行时分组白名单决定是否可调用", () => {
    expect(imageModelIdSchema.parse("firefly-gpt-image-2")).toBe(
      "firefly-gpt-image-2"
    );
    expect(imageModelIdSchema.parse("FIREFLY-NANO-BANANA-PRO")).toBe(
      "FIREFLY-NANO-BANANA-PRO"
    );
  });

  it("拒绝超过 120 个字符的模型 ID", () => {
    expect(imageModelIdSchema.safeParse("m".repeat(121)).success).toBe(false);
  });
});
