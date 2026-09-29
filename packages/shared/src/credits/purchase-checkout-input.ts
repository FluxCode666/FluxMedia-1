/**
 * 积分包购买输入约束。
 *
 * 使用方：createCreditsPurchaseCheckout Action 与 credits.createPurchaseCheckout UOL
 * operation，两者共用同一份 schema，浏览器侧不引入 UOL 服务端依赖。
 */
import { z } from "zod";
import { CREDIT_PACKAGE_PURCHASE_MAX_QUANTITY } from "./purchase-checkout-service";

/** 积分包购买的共享输入 schema，供 UOL 与 Action 使用同一约束。 */
export const createPurchaseCheckoutInputSchema = z
  .object({
    packageId: z.string().min(1).describe("积分包 ID"),
    clientRequestId: z.string().uuid().describe("客户端生成的幂等请求 ID"),
    locale: z.enum(["en", "zh"]).describe("支付结果页语言"),
    quantity: z
      .number()
      .int()
      .min(1)
      .max(CREDIT_PACKAGE_PURCHASE_MAX_QUANTITY)
      .optional()
      .describe("购买数量，省略时为 1"),
  })
  .strict();
