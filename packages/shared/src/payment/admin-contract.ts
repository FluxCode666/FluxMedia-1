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

export const ADMIN_PAYMENT_OVERVIEW_MAX_DAYS = 366;
export const ADMIN_PAYMENT_ORDER_DEFAULT_DAYS = 7;

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

const calendarDateSchema = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/, "日期必须位于 2000 至 2099 年")
  .date();
const emailSchema = z.string().trim().email().max(320);
const cursorSchema = z.string().min(1).max(4096);
const currencySchema = z.string().trim().length(3);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

type AdminPaymentCalendarDateRange = {
  startDate?: string | undefined;
  endDate?: string | undefined;
};

/** 校验成对、正序且有界的管理端支付日历日期范围。 */
function validateAdminPaymentDateRange(
  input: AdminPaymentCalendarDateRange,
  context: z.RefinementCtx
): void {
  if (Boolean(input.startDate) !== Boolean(input.endDate)) {
    context.addIssue({
      code: "custom",
      message: "开始日期和结束日期必须同时提供",
    });
    return;
  }
  if (!input.startDate || !input.endDate) return;
  if (input.startDate > input.endDate) {
    context.addIssue({
      code: "custom",
      message: "结束日期不能早于开始日期",
      path: ["endDate"],
    });
    return;
  }
  const startTime = Date.parse(`${input.startDate}T00:00:00.000Z`);
  const endTime = Date.parse(`${input.endDate}T00:00:00.000Z`);
  const dayCount = Math.floor((endTime - startTime) / 86_400_000) + 1;
  if (dayCount > ADMIN_PAYMENT_OVERVIEW_MAX_DAYS) {
    context.addIssue({
      code: "custom",
      message: `日期范围不能超过 ${ADMIN_PAYMENT_OVERVIEW_MAX_DAYS} 天`,
      path: ["endDate"],
    });
  }
}

export const adminPaymentOverviewInputSchema = z
  .object({
    startDate: calendarDateSchema.optional(),
    endDate: calendarDateSchema.optional(),
  })
  .strict()
  .superRefine(validateAdminPaymentDateRange);

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
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    timeZone: z.string().min(1).max(100),
    rangeStart: isoDateTimeSchema,
    rangeEnd: isoDateTimeSchema,
    rechargeOrderCount: nonnegativeSafeIntegerSchema,
    revenueDayCount: nonnegativeSafeIntegerSchema,
    revenueTotals: z.array(currencyAmountSchema).max(32),
    daily: z
      .array(adminPaymentDailyPointSchema)
      .min(1)
      .max(ADMIN_PAYMENT_OVERVIEW_MAX_DAYS),
  })
  .strict();

export const adminPaymentOrderListInputSchema = z
  .object({
    cursor: cursorSchema.optional(),
    endDate: calendarDateSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
    orderId: z.string().trim().min(1).max(128).optional(),
    startDate: calendarDateSchema.optional(),
    status: adminPaymentOrderStatusSchema.optional(),
    userEmail: emailSchema.optional(),
  })
  .strict()
  .superRefine(validateAdminPaymentDateRange)
  .superRefine((input, context) => {
    if (input.cursor && (!input.startDate || !input.endDate)) {
      context.addIssue({
        code: "custom",
        message: "分页游标必须携带原日期范围",
        path: ["cursor"],
      });
    }
  });

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
