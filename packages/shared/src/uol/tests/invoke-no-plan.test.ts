/**
 * UOL 无套餐门禁回归测试。
 *
 * 职责：证明 API Key Principal 不需要套餐字段，统一网关只执行身份、严格输入和
 * 幂等校验，不再动态读取用户套餐或商业能力矩阵。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { invokeOperation } from "../invoke";
import type { Principal } from "../principal";
import { clearRegistry, defineOperation } from "../registry";

const apiKeyPrincipal = {
  type: "apiKey",
  credentialKind: "external",
  userId: "user-1",
  apiKeyId: "key-1",
} satisfies Principal;

/** 注册一个只受 API Key 身份与严格输入保护的媒体操作。 */
function registerMediaOperation() {
  const execute = vi.fn(async () => ({ ok: true }));
  defineOperation({
    name: "media.test",
    domain: "image-generation",
    title: "媒体测试",
    description: "验证无套餐统一调用路径",
    input: z.object({ mode: z.enum(["generate", "edit"]) }).strict(),
    output: z.object({ ok: z.boolean() }),
    access: { kind: "apiKey" },
    readOnly: false,
    destructive: false,
    idempotency: { kind: "none" },
    sideEffects: [],
    execute,
  });
  return execute;
}

describe("invokeOperation without plan capabilities", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("允许无 plan 的 API Key Principal 执行一次", async () => {
    const execute = registerMediaOperation();

    await expect(
      invokeOperation("media.test", { mode: "generate" }, apiKeyPrincipal)
    ).resolves.toEqual({ ok: true });
    expect(apiKeyPrincipal).not.toHaveProperty("plan");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("仍在执行前拒绝未知输入字段", async () => {
    const execute = registerMediaOperation();

    await expect(
      invokeOperation(
        "media.test",
        { mode: "generate", plan: "enterprise" },
        apiKeyPrincipal
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(execute).not.toHaveBeenCalled();
  });
});
