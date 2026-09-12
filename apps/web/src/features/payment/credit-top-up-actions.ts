"use server";

/**
 * 按金额积分充值的 Server Action 传输适配器。
 *
 * 使用方：购买积分页面。
 * 关键依赖：UOL 网关、受保护会话、用户角色解析。
 *
 * 本文件不直接访问订单或支付 SDK；职责仅限解析输入、构造 Principal 并调用
 * invokeOperation，保证 Web UI 与支付回调共享同一订单履约内核。
 */
import { z } from "zod";

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { protectedAction } from "@repo/shared/safe-action";
import { invokeOperation } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";
import { requestGoJson } from "@/server/go-backend-client";

const topUpCheckoutSchema = z.object({
  clientRequestId: z.string().uuid(),
  currency: z.string().trim().length(3),
  amountMinor: z.number().int().positive(),
  provider: z.literal("alipay_f2f"),
});

/** 获取当前用户可见的充值选项。 */
export const getCreditTopUpOptionsAction = protectedAction
  .metadata({ action: "credits.getTopUpOptions" })
  .action(async () => {
    return requestGoJson<{
      enabled: boolean;
      defaultCurrency: string;
      currencies: Array<{
        currency: string;
        creditsPerMajorUnit: number;
        minAmountMinor: number;
        maxAmountMinor: number;
        providers: Array<"alipay_f2f">;
      }>;
    }>("/api/credits/top-up/options");
  });

/** 创建按金额积分充值二维码订单。 */
export const createCreditTopUpCheckoutAction = protectedAction
  .metadata({ action: "credits.createTopUpCheckout" })
  .schema(topUpCheckoutSchema)
  .action(async ({ parsedInput, ctx }) => {
    await ensureUolInitialized();
    const role = await getUserRoleById(ctx.userId);
    return invokeOperation<{
      orderId: string;
      status: string;
      currency: string;
      amount: number;
      amountMinor: number;
      creditsAmount: number;
      qrCode: string | null;
      expiresAt: string | null;
    }>("credits.createTopUpCheckout", parsedInput, {
      type: "user",
      userId: ctx.userId,
      role,
    });
  });

/** 查询当前用户自己的充值订单状态，用于二维码支付后的短轮询。 */
export const getCreditTopUpOrderStatusAction = protectedAction
  .metadata({ action: "credits.getTopUpOrderStatus" })
  .schema(z.object({ orderId: z.string().min(1) }))
  .action(async ({ parsedInput, ctx }) => {
    await ensureUolInitialized();
    const role = await getUserRoleById(ctx.userId);
    return invokeOperation<{
      orderId: string;
      status: string;
      currency: string;
      amount: number;
      creditsAmount: number;
      qrCode: string | null;
      expiresAt: string | null;
      fulfilledAt: string | null;
    }>("credits.getTopUpOrderStatus", parsedInput, {
      type: "user",
      userId: ctx.userId,
      role,
    });
  });

/** 查询当前用户自己的统一积分支付状态，供支付结果页轮询。 */
export const getCreditPaymentStatusAction = protectedAction
  .metadata({ action: "credits.getPaymentStatus" })
  .schema(z.object({ orderId: z.string().min(1) }))
  .action(async ({ parsedInput, ctx }) => {
    await ensureUolInitialized();
    const role = await getUserRoleById(ctx.userId);
    return invokeOperation<{
      orderId: string;
      provider: "alipay_f2f" | "epay" | "creem";
      status:
        | "waiting_payment"
        | "payment_confirmed"
        | "fulfilled"
        | "failed"
        | "expired";
      currency: string;
      amount: number;
      creditsAmount: number;
      qrCode: string | null;
      expiresAt: string | null;
      fulfilledAt: string | null;
    }>("credits.getPaymentStatus", parsedInput, {
      type: "user",
      userId: ctx.userId,
      role,
    });
  });
