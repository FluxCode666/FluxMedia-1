/**
 * 用户侧充值订单查询契约。
 *
 * 使用方：支付 UOL operation、钱包页聚合 Action 与最近充值订单列表。
 * 仅公开当前用户理解订单进度所需的字段，不包含用户 ID、渠道交易号或支付快照。
 */
import { z } from "zod";

export const USER_RECENT_PAYMENT_ORDER_LIMIT = 8;

export const userPaymentOrderListInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(USER_RECENT_PAYMENT_ORDER_LIMIT),
  })
  .strict();

export const userPaymentOrderSchema = z
  .object({
    id: z.string().min(1).max(128),
    provider: z.enum(["alipay_f2f", "creem", "epay"]),
    purpose: z.enum(["credit_top_up", "credit_package"]),
    status: z.enum([
      "waiting_payment",
      "payment_confirmed",
      "fulfilled",
      "failed",
      "expired",
    ]),
    currency: z.string().trim().length(3),
    amountMinor: z.number().int().positive().safe(),
    creditsAmount: z.number().finite().positive(),
    createdAt: z.string().datetime({ offset: true }),
    fulfilledAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const userPaymentOrderListOutputSchema = z
  .object({
    asOf: z.string().datetime({ offset: true }),
    timeZone: z.string().min(1).max(100),
    records: z.array(userPaymentOrderSchema).max(20),
  })
  .strict();

export type UserPaymentOrderListInput = z.input<
  typeof userPaymentOrderListInputSchema
>;
export type UserPaymentOrderListOutput = z.output<
  typeof userPaymentOrderListOutputSchema
>;
export type UserPaymentOrder = z.output<typeof userPaymentOrderSchema>;
