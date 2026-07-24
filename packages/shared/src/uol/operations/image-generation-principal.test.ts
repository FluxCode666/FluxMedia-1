/**
 * image.generate UOL 身份边界测试。
 *
 * 职责：验证统一生图操作只接受业务参数，身份由 Principal 提供，旧治理字段
 * 不能进入 MCP/UOL 输入契约。
 */
import { describe, expect, it } from "vitest";

import { getOperation } from "../registry";
import { imageGenerateInputSchema } from "./image-generation";

describe("image.generate principal-bound contract", () => {
  it("accepts generation parameters without a client identity", () => {
    expect(
      imageGenerateInputSchema.safeParse({
        prompt: "a test image",
        backendGroupId: "group-a",
      }).success
    ).toBe(true);
  });

  it.each([
    "userId",
    "relayOnly",
    "relay_only",
    "moderationBlockRiskLevel",
    "userModerationBlockRiskLevel",
    "extra",
  ])("rejects client-controlled field %s", (field) => {
    expect(
      imageGenerateInputSchema.safeParse({
        prompt: "a test image",
        [field]: field === "userId" ? "another-user" : "low",
      }).success
    ).toBe(false);
  });

  it("registers the strict schema on image.generate", () => {
    expect(getOperation("image.generate")?.input).toBe(
      imageGenerateInputSchema
    );
  });
});
