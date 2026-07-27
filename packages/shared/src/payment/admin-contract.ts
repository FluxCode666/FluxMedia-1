/**
 * 管理端充值支付查询契约。
 *
 * 使用方：支付管理 UOL operation、Server Action 与管理后台页面。
 * 关键依赖：Zod。所有金额跨接口只传最小货币单位整数，避免浮点金额累加误差。
 */
import { z } from "zod";

export const ADMIN_PAYMENT_ORDER_STATUSES = [
  "creating",
  "pending",
  "fulfilling",
  "fulfilled",
  "failed",
] as const;

export const adminPaymentOrderStatusSchema = z.enum(
  ADMIN_PAYMENT_ORDER_STATUSES
);

export const adminPaymentOrderPurposeSchema = z.enum([
  "credit_top_up",
  "credit_package",
]);

export const adminPaymentOrderProviderSchema = z.enum([
  "alipay_f2f",
  "creem",
  "epay",
]);

const calendarMonthSchema = z
  .string()
  .regex(/^20\d{2}-(0[1-9]|1[0-2])$/, "月份格式必须为 YYYY-MM");
const emailSchema = z.string().trim().email().max(320);
const cursorSchema = z.string().min(1).max(4096);
const currencySchema = z.string().trim().length(3);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

export const adminPaymentOverviewInputSchema = z
  .object({ month: calendarMonthSchema.optional() })
  .strict();

const currencyAmountSchema = z
  .object({
    currency: currencySchema,
    amountMinor: nonnegativeSafeIntegerSchema,
  })
  .strict();

const adminPaymentDailyPointSchema = z
  .object({
    date: z.string().date(),
    orderCount: nonnegativeSafeIntegerSchema,
    revenue: z.array(currencyAmountSchema).max(32),
  })
  .strict();

export const adminPaymentOverviewOutputSchema = z
  .object({
    month: calendarMonthSchema,
    timeZone: z.string().min(1).max(100),
    rangeStart: isoDateTimeSchema,
    rangeEnd: isoDateTimeSchema,
    successfulOrderCount: nonnegativeSafeIntegerSchema,
    activeDayCount: nonnegativeSafeIntegerSchema,
    revenueTotals: z.array(currencyAmountSchema).max(32),
    daily: z.array(adminPaymentDailyPointSchema).min(28).max(31),
  })
  .strict();

export const adminPaymentOrderListInputSchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    orderId: z.string().trim().min(1).max(128).optional(),
    status: adminPaymentOrderStatusSchema.optional(),
    userEmail: emailSchema.optional(),
  })
  .strict();

export const adminPaymentOrderSchema = z
  .object({
    id: z.string().min(1).max(128),
    userId: z.string().min(1).max(512),
    userEmail: emailSchema,
    provider: adminPaymentOrderProviderSchema,
    purpose: adminPaymentOrderPurposeSchema,
    status: adminPaymentOrderStatusSchema,
    currency: currencySchema,
    amountMinor: nonnegativeSafeIntegerSchema,
    creditsAmount: z.number().finite().nonnegative(),
    providerTradeNo: z.string().max(512).nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema.nullable(),
    fulfilledAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export const adminPaymentOrderListOutputSchema = z
  .object({
    records: z.array(adminPaymentOrderSchema),
    nextCursor: cursorSchema.nullable(),
    previousCursor: cursorSchema.nullable(),
  })
  .strict();

export const adminPaymentUserSearchInputSchema = z
  .object({
    query: z.string().trim().max(160).default(""),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const adminPaymentUserOptionSchema = z
  .object({
    id: z.string().min(1).max(512),
    email: emailSchema,
  })
  .strict();

export const adminPaymentUserSearchOutputSchema = z
  .object({ users: z.array(adminPaymentUserOptionSchema).max(50) })
  .strict();

export type AdminPaymentOverviewInput = z.input<
  typeof adminPaymentOverviewInputSchema
>;
export type AdminPaymentOverviewOutput = z.output<
  typeof adminPaymentOverviewOutputSchema
>;
export type AdminPaymentOrderListInput = z.input<
  typeof adminPaymentOrderListInputSchema
>;
export type AdminPaymentOrderListOutput = z.output<
  typeof adminPaymentOrderListOutputSchema
>;
export type AdminPaymentOrder = z.output<typeof adminPaymentOrderSchema>;
export type AdminPaymentOrderStatus = z.output<
  typeof adminPaymentOrderStatusSchema
>;
export type AdminPaymentUserSearchInput = z.input<
  typeof adminPaymentUserSearchInputSchema
>;
export type AdminPaymentUserSearchOutput = z.output<
  typeof adminPaymentUserSearchOutputSchema
>;
