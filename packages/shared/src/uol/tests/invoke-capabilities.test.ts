/**
 * UOL 套餐能力单点门禁测试。
 *
 * 职责：验证能力推导读取已校验 input 与 Principal，session 计划来自服务端，API Key
 * 使用 Principal 携带计划，且拒绝发生在 execute 之前。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { invokeOperation } from "../invoke";
import type { Principal } from "../principal";
import { clearRegistry, defineOperation } from "../registry";

const capabilityMocks = vi.hoisted(() => ({
  canUsePlanCapability: vi.fn(),
  getUserPlanType: vi.fn(),
}));

vi.mock("../../subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: capabilityMocks.canUsePlanCapability,
  PLAN_CAPABILITY_KEYS: [
    "imageGeneration.text",
    "imageGeneration.edit",
    "externalApi.images.generate",
    "externalApi.images.edit",
  ],
}));

vi.mock("../../subscription/services/user-plan", () => ({
  getUserPlanType: capabilityMocks.getUserPlanType,
}));

const userPrincipal: Principal = {
  type: "user",
  userId: "user-1",
  role: "user",
};

const apiKeyPrincipal: Principal = {
  type: "apiKey",
  userId: "user-1",
  apiKeyId: "key-1",
  plan: "starter",
};

function registerMediaOperation(options?: { allowSystemBypass?: boolean }) {
  const execute = vi.fn(async () => ({ ok: true }));
  defineOperation({
    name: "media.test",
    domain: "image-generation",
    title: "媒体测试",
    description: "验证 Principal 感知的能力推导",
    input: z.object({ mode: z.enum(["generate", "edit"]) }).strict(),
    output: z.object({ ok: z.boolean() }),
    access: { kind: "protected" },
    capabilities: [
      {
        derive: (input, principal) => {
          const mediaInput = input as { mode: "generate" | "edit" };
          const prefix =
            principal.type === "apiKey"
              ? "externalApi.images"
              : "imageGeneration";
          return [
            mediaInput.mode === "edit"
              ? `${prefix}.edit`
              : `${prefix}.${prefix === "imageGeneration" ? "text" : "generate"}`,
          ];
        },
      },
    ],
    ...(options?.allowSystemBypass !== undefined
      ? { allowSystemCapabilityBypass: options.allowSystemBypass }
      : {}),
    readOnly: false,
    destructive: false,
    idempotency: { kind: "none" },
    sideEffects: [],
    execute,
  });
  return execute;
}

describe("invokeOperation capabilities", () => {
  beforeEach(() => {
    clearRegistry();
    capabilityMocks.canUsePlanCapability.mockReset();
    capabilityMocks.getUserPlanType.mockReset();
  });

  it("uses the server-side session plan and rejects before execute", async () => {
    const execute = registerMediaOperation();
    capabilityMocks.getUserPlanType.mockResolvedValue("free");
    capabilityMocks.canUsePlanCapability.mockResolvedValue(false);

    await expect(
      invokeOperation("media.test", { mode: "edit" }, userPrincipal)
    ).rejects.toMatchObject({
      code: "capability_required",
    });
    expect(capabilityMocks.getUserPlanType).toHaveBeenCalledWith("user-1");
    expect(capabilityMocks.canUsePlanCapability).toHaveBeenCalledWith(
      "free",
      "imageGeneration.edit"
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses API Key plan and lets an allowed operation execute once", async () => {
    const execute = registerMediaOperation();
    capabilityMocks.canUsePlanCapability.mockResolvedValue(true);

    await expect(
      invokeOperation("media.test", { mode: "generate" }, apiKeyPrincipal)
    ).resolves.toEqual({ ok: true });
    expect(capabilityMocks.getUserPlanType).not.toHaveBeenCalled();
    expect(capabilityMocks.canUsePlanCapability).toHaveBeenCalledWith(
      "starter",
      "externalApi.images.generate"
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not let system bypass capabilities unless explicitly declared", async () => {
    const systemPrincipal: Principal = { type: "system", reason: "worker" };
    const rejectedExecute = registerMediaOperation();

    await expect(
      invokeOperation("media.test", { mode: "generate" }, systemPrincipal)
    ).rejects.toMatchObject({
      code: "capability_required",
    });
    expect(rejectedExecute).not.toHaveBeenCalled();

    clearRegistry();
    const allowedExecute = registerMediaOperation({ allowSystemBypass: true });
    await expect(
      invokeOperation("media.test", { mode: "generate" }, systemPrincipal)
    ).resolves.toEqual({ ok: true });
    expect(allowedExecute).toHaveBeenCalledTimes(1);
  });

  it("validates input before deriving capabilities", async () => {
    const execute = registerMediaOperation();

    await expect(
      invokeOperation(
        "media.test",
        { mode: "generate", previousResponseId: "legacy" },
        userPrincipal
      )
    ).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(capabilityMocks.canUsePlanCapability).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
