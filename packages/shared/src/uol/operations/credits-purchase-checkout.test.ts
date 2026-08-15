/**
 * 积分包购买 Checkout UOL 契约测试。
 *
 * 使用方：Vitest。锁定真实 Action 输入、per-user 幂等声明、Principal 用户绑定和
 * 安全领域错误映射；生产 Checkout service 使用 mock，测试不连接数据库。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const checkoutMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
});

vi.mock("../../credits/purchase-checkout-runtime", () => ({
  createRuntimeCreditPackagePurchaseCheckout: checkoutMocks.create,
}));

import { CreditPackagePurchaseCheckoutError } from "../../credits/purchase-checkout-service";
import { invokeOperation } from "../invoke";
import {
  createPurchaseCheckout,
  createPurchaseCheckoutInputSchema,
} from "./credits";

const validInput = {
  packageId: "starter",
  clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462",
  locale: "zh",
  quantity: 2,
} as const;

describe("credits.createPurchaseCheckout", () => {
  beforeEach(() => {
    checkoutMocks.create.mockReset();
  });

  it("注册真实 Action 输入、输出和 per-user 幂等契约", () => {
    expect(createPurchaseCheckout).toMatchObject({
      access: { kind: "protected" },
      agentExposure: "human-only",
      readOnly: false,
      destructive: false,
      idempotency: {
        kind: "required",
        keyField: "clientRequestId",
        scope: "per-user",
      },
      sideEffects: ["billing", "external-call"],
    });
    expect(
      createPurchaseCheckoutInputSchema.safeParse(validInput).success
    ).toBe(true);
    expect(
      createPurchaseCheckoutInputSchema.safeParse({
        ...validInput,
        userId: "another-user",
      }).success
    ).toBe(false);
    expect(
      createPurchaseCheckout.output.safeParse({
        url: "https://pay.example.test/submit",
        orderId: "order-1",
        params: { sign: "signed" },
        method: "POST",
      }).success
    ).toBe(true);
  });

  it("只从 Principal 注入用户 ID 后执行真实 service", async () => {
    checkoutMocks.create.mockResolvedValue({
      url: "https://checkout.example.test/session",
      orderId: "order-1",
    });

    await expect(
      invokeOperation(createPurchaseCheckout.name, validInput, {
        type: "user",
        userId: "user-1",
        role: "user",
      })
    ).resolves.toEqual({
      url: "https://checkout.example.test/session",
      orderId: "order-1",
    });
    expect(checkoutMocks.create).toHaveBeenCalledWith({
      userId: "user-1",
      ...validInput,
    });
  });

  it("把安全领域错误映射为可识别的 UOL 错误", async () => {
    checkoutMocks.create.mockRejectedValue(
      new CreditPackagePurchaseCheckoutError(
        "provider_not_configured",
        "Creem 支付通道未完整配置，请联系管理员填写 API Key 和 Webhook Secret"
      )
    );

    await expect(
      invokeOperation(createPurchaseCheckout.name, validInput, {
        type: "user",
        userId: "user-1",
        role: "user",
      })
    ).rejects.toMatchObject({
      code: "not_ready",
      message:
        "Creem 支付通道未完整配置，请联系管理员填写 API Key 和 Webhook Secret",
      details: {
        userSafe: true,
        reason: "provider_not_configured",
      },
    });
  });
});
