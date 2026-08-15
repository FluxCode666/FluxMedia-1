/**
 * 运营明细数据库结果的运行时校验与 DTO 映射。
 *
 * 使用方：detail-repository。数据库驱动返回值一律视为 unknown，并在进入服务层或
 * CSV worker 前通过 Zod 收窄，避免异常列形状静默污染管理端数据。
 */
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

import type {
  OperationsCommercialDetailRow,
  OperationsContentDetailRow,
  OperationsGrowthDetailRow,
} from "./detail-contracts";

const exactDatabaseTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "游标时间无效");

const growthDetailDatabaseRowSchema = z.object({
  user_id: z.string().min(1),
  name: z.string(),
  email: z.string().email(),
  role: z.string().min(1),
  banned: z.boolean(),
  business_time: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "明细业务时间无效"),
  business_time_key: exactDatabaseTimestampSchema,
  retained: z.boolean().nullable(),
});

const commercialDetailDatabaseRowSchema = z.object({
  kind: z.enum([
    "orders",
    "fulfilled_orders",
    "payment_lifecycle",
    "payment_stage",
  ]),
  stable_id: z.string().min(1),
  payment_order_id: z.string().min(1),
  provider_trade_no: z.string().nullable(),
  user_id: z.string().min(1),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/),
  amount_minor: z.coerce.number().int().safe().nonnegative(),
  order_status: z.string().min(1),
  created_at: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "订单创建时间无效"),
  fulfilled_at: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "订单履约时间无效")
    .nullable(),
  business_time: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "商业化业务时间无效"),
  business_time_key: exactDatabaseTimestampSchema,
  event_type: z.string().nullable(),
});

const contentDetailDatabaseRowSchema = z.object({
  stable_id: z.string().min(1),
  task_id: z.string().min(1),
  user_id: z.string().min(1),
  model: z.string().min(1),
  media_type: z.enum(["image", "video"]),
  business_time: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "内容业务时间无效"),
  business_time_key: exactDatabaseTimestampSchema,
  status: z.literal("completed"),
  quantity: z.coerce.number().int().safe().positive(),
  video_seconds: z.coerce.number().int().safe().nonnegative(),
  net_credits: z.coerce.number().finite().nonnegative(),
  operation_created_at_mismatch: z.boolean(),
});

/** 将不可信数据库行严格收窄为增长明细 DTO。 */
export function parseOperationsGrowthDetailRows(
  result: unknown
): OperationsGrowthDetailRow[] {
  return z
    .array(growthDetailDatabaseRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      kind: "growth" as const,
      userId: row.user_id,
      name: row.name,
      email: row.email,
      role: row.role,
      banned: row.banned,
      businessTime: row.business_time,
      businessTimeKey: row.business_time_key,
      retained: row.retained,
    }));
}

/** 将不可信数据库行严格收窄为商业化安全 DTO。 */
export function parseOperationsCommercialDetailRows(
  result: unknown
): OperationsCommercialDetailRow[] {
  return z
    .array(commercialDetailDatabaseRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      kind: row.kind,
      stableId: row.stable_id,
      paymentOrderId: row.payment_order_id,
      providerTradeNo: row.provider_trade_no,
      userId: row.user_id,
      currency: row.currency,
      amountMinor: row.amount_minor,
      orderStatus: row.order_status,
      createdAt: row.created_at,
      fulfilledAt: row.fulfilled_at,
      businessTime: row.business_time,
      businessTimeKey: row.business_time_key,
      eventType: row.event_type,
    }));
}

/** 将不可信数据库行严格收窄为内容生产安全 DTO。 */
export function parseOperationsContentDetailRows(
  result: unknown
): OperationsContentDetailRow[] {
  return z
    .array(contentDetailDatabaseRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      kind: "content",
      stableId: row.stable_id,
      taskId: row.task_id,
      userId: row.user_id,
      model: row.model,
      mediaType: row.media_type,
      businessTime: row.business_time,
      businessTimeKey: row.business_time_key,
      status: row.status,
      quantity: row.quantity,
      videoSeconds: row.video_seconds,
      netCredits: row.net_credits,
      operationCreatedAtMismatch: row.operation_created_at_mismatch,
    }));
}
