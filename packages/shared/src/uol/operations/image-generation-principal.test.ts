/**
 * image.generate UOL 身份边界测试。
 *
 * 职责：验证统一生图操作只接受业务参数，身份由 Principal 提供，旧治理字段
 * 不能进入 MCP/UOL 输入契约。
 */
import { describe, expect, it } from "vitest";

import type { Principal } from "../principal";
import { getOperation } from "../registry";
import { imageGenerate, imageGenerateInputSchema } from "./image-generation";

describe("image.generate principal-bound contract", () => {
  it("accepts generation parameters without a client identity", () => {
    expect(
      imageGenerateInputSchema.safeParse({
        operation: "generate",
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
        operation: "generate",
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

  it("按凭据来源区分外部 API 与 MCP 的套餐能力", () => {
    const requirement = imageGenerate.capabilities?.[0];
    if (!requirement || !("derive" in requirement)) {
      throw new Error("image.generate 缺少动态套餐能力声明");
    }
    const input = { operation: "generate" as const, prompt: "a test image" };
    const externalPrincipal = {
      type: "apiKey",
      credentialKind: "external",
      userId: "user-1",
      apiKeyId: "external-key-1",
      plan: "pro",
    } satisfies Principal;
    const mcpPrincipal = {
      type: "apiKey",
      credentialKind: "mcp",
      userId: "user-1",
      apiKeyId: "mcp-key-1",
      plan: "pro",
    } satisfies Principal;

    expect(requirement.derive(input, externalPrincipal)).toEqual([
      "externalApi.images.generate",
    ]);
    expect(requirement.derive(input, mcpPrincipal)).toEqual([
      "imageGeneration.text",
    ]);
  });

  it("accepts generate, edit and mask variants with JSON-safe media", () => {
    const image = {
      source: "storage",
      mimeType: "image/png",
      storageKey: "users/u1/input.png",
      byteLength: 100,
    };
    expect(
      imageGenerateInputSchema.safeParse({
        operation: "generate",
        prompt: "new image",
      }).success
    ).toBe(true);
    expect(
      imageGenerateInputSchema.safeParse({
        operation: "edit",
        prompt: "edit image",
        images: [image],
      }).success
    ).toBe(true);
    expect(
      imageGenerateInputSchema.safeParse({
        operation: "mask",
        prompt: "mask edit",
        images: [image],
        mask: image,
      }).success
    ).toBe(true);
  });
});
