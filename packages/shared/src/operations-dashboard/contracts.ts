/**
 * 运营总览页面、明细、导出和聚合服务共享的 strict 契约。
 *
 * 使用方：后续 operations UOL、领域服务、Web 页面和导出 worker。关键依赖仅为
 * Zod 与既有 Gregorian 日期契约；本文件不读取数据库、运行时设置或调用方身份。
 */
import { z } from "zod";

import { operationsAppDateSchema } from "./facts-contracts";

/** 默认范围包含今天在内的应用时区自然日数量。 */
export const OPERATIONS_DASHBOARD_DEFAULT_DAYS = 30;

/** 运营趋势支持的手动粒度，默认值由查询输入 schema 提供。 */
export const operationsGranularitySchema = z.enum(["day", "week", "month"]);

const defaultRangeSchema = z.object({ kind: z.literal("default") }).strict();
const thisWeekRangeSchema = z.object({ kind: z.literal("this_week") }).strict();
const thisMonthRangeSchema = z
  .object({ kind: z.literal("this_month") })
  .strict();
const thisYearRangeSchema = z.object({ kind: z.literal("this_year") }).strict();
const customRangeSchema = z
  .object({
    kind: z.literal("custom"),
    from: operationsAppDateSchema,
    to: operationsAppDateSchema,
  })
  .strict();

/** 日期选择器可提交的封闭范围集合；顺序和未来边界在固定 asOf 下解析。 */
export const operationsDateRangeInputSchema = z.discriminatedUnion("kind", [
  defaultRangeSchema,
  thisWeekRangeSchema,
  thisMonthRangeSchema,
  thisYearRangeSchema,
  customRangeSchema,
]);

/**
 * 运营总览的公共查询输入。
 *
 * 空对象规范化为近三十日和日粒度；strict 对象刻意不接受 userId、时区、asOf 或
 * epoch，避免调用方越权改变全站统计身份与服务器时间语义。
 */
export const operationsDashboardQueryInputSchema = z
  .object({
    granularity: operationsGranularitySchema.default("day"),
    range: operationsDateRangeInputSchema.default({ kind: "default" }),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.range.kind === "custom" && input.range.from > input.range.to) {
      context.addIssue({
        code: "custom",
        message: "结束日期不能早于开始日期",
        path: ["range", "to"],
      });
    }
  });

/** 运营总览的四个纵向业务模块。 */
export const operationsModuleSchema = z.enum([
  "growth",
  "commercialization",
  "content",
  "system_health",
]);

const growthDetailSelectionSchema = z
  .object({
    module: z.literal("growth"),
    detail: z.enum([
      "users",
      "login_activity",
      "creation_activity",
      "payment_activity",
      "retention_cohorts",
    ]),
  })
  .strict();
const commercializationDetailSelectionSchema = z
  .object({
    module: z.literal("commercialization"),
    detail: z.enum(["orders", "payment_lifecycle"]),
  })
  .strict();
const contentDetailSelectionSchema = z
  .object({
    module: z.literal("content"),
    detail: z.enum(["image_outputs", "video_outputs", "credit_usage"]),
  })
  .strict();
/** 模块与明细种类的合法组合；拒绝把订单明细伪装成内容明细等跨域请求。 */
export const operationsDetailSelectionSchema = z.discriminatedUnion("module", [
  growthDetailSelectionSchema,
  commercializationDetailSelectionSchema,
  contentDetailSelectionSchema,
]);

/** 三类可异步导出的领域数据；系统健康按产品约束不提供 CSV。 */
export const operationsExportTypeSchema = z.enum([
  "user_growth",
  "commercialization",
  "content_production",
]);

/** 页面跨模块区分真实值、缺失事实和实时值的稳定状态名称。 */
export const operationsSpecialStatusSchema = z.enum([
  "value",
  "pre_epoch",
  "not_comparable",
  "immature",
  "current",
  "no_data",
]);

/** 历史范围或桶相对生产统计起点的可用性。 */
export const operationsRangeAvailabilitySchema = z.enum([
  "available",
  "partial_epoch",
  "pre_epoch",
]);

/** Keyset 分页游标是不透明、非空且有界的服务器签名字符串。 */
export const operationsCursorSchema = z.string().trim().min(1).max(4096);

/** 数量必须是不会在 JSON/JavaScript 边界丢失精度的非负整数。 */
export const operationsCountSchema = z.number().int().nonnegative().safe();

/** 积分可为正负有限小数，具体显示精度不改变服务层原始值。 */
export const operationsCreditValueSchema = z.number().finite();

/** 比率以未格式化的 0 到 1 数值跨边界传递。 */
export const operationsRateSchema = z.number().finite().min(0).max(1);

/** 百分比变化允许负数和超过 100%，但绝不允许 Infinity 或 NaN。 */
export const operationsPercentChangeSchema = z.number().finite();

/** 百分点变化使用有限数值，UI 再决定小数位。 */
export const operationsPercentagePointChangeSchema = z.number().finite();

/** 单币种金额使用 ISO 风格大写三字母和安全的非负最小单位整数。 */
export const operationsCurrencyAmountSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountMinor: operationsCountSchema,
  })
  .strict();

export type OperationsGranularity = z.infer<typeof operationsGranularitySchema>;
export type OperationsDateRangeInput = z.infer<
  typeof operationsDateRangeInputSchema
>;
export type OperationsDashboardQueryInput = z.infer<
  typeof operationsDashboardQueryInputSchema
>;
export type OperationsRangeAvailability = z.infer<
  typeof operationsRangeAvailabilitySchema
>;
export type OperationsCurrencyAmount = z.infer<
  typeof operationsCurrencyAmountSchema
>;
