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

/** 图表下钻使用的完整应用日期桶；首尾日期均为闭区间。 */
export const operationsDetailBucketSchema = z
  .object({
    from: operationsAppDateSchema,
    to: operationsAppDateSchema,
  })
  .strict()
  .superRefine((bucket, context) => {
    if (bucket.from > bucket.to) {
      context.addIssue({
        code: "custom",
        message: "明细桶结束日期不能早于开始日期",
        path: ["to"],
      });
    }
  });

/** 支付阶段图可逐订单核对的封闭阶段集合。 */
export const operationsPaymentLifecycleStageSchema = z.enum([
  "created_orders",
  "pending_orders",
  "payment_confirmed_orders",
  "paid_not_fulfilled_orders",
  "fulfilled_orders",
  "failed_orders",
]);

export type OperationsPaymentLifecycleStage = z.infer<
  typeof operationsPaymentLifecycleStageSchema
>;

/** 订单明细可选的标准大写三字母币种过滤。 */
const operationsDetailCurrencySchema = z.string().regex(/^[A-Z]{3}$/);

const growthNonCohortDetailSelectionSchema = z
  .object({
    module: z.literal("growth"),
    detail: z.enum([
      "users",
      "login_activity",
      "creation_activity",
      "payment_activity",
    ]),
  })
  .strict();
const growthCohortDetailSelectionSchema = z
  .object({
    module: z.literal("growth"),
    detail: z.literal("retention_cohorts"),
    cohortDate: operationsAppDateSchema,
    retentionDay: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  })
  .strict();
const growthCumulativeUsersDetailSelectionSchema = z
  .object({
    module: z.literal("growth"),
    detail: z.literal("cumulative_users"),
    cutoffDate: operationsAppDateSchema,
  })
  .strict();
const growthActivityBucketDetailSelectionSchema = z
  .object({
    module: z.literal("growth"),
    detail: z.literal("activity_bucket"),
    activityKind: z.enum(["new_users", "login", "creation", "payment"]),
    bucket: operationsDetailBucketSchema,
  })
  .strict();
const growthDetailSelectionSchema = z.union([
  growthNonCohortDetailSelectionSchema,
  growthCohortDetailSelectionSchema,
  growthCumulativeUsersDetailSelectionSchema,
  growthActivityBucketDetailSelectionSchema,
]);
const commercializationRangeDetailSelectionSchema = z
  .object({
    module: z.literal("commercialization"),
    detail: z.enum(["orders", "payment_lifecycle"]),
  })
  .strict();
const commercializationFulfilledDetailSelectionSchema = z
  .object({
    module: z.literal("commercialization"),
    detail: z.literal("fulfilled_orders"),
    currency: operationsDetailCurrencySchema.optional(),
  })
  .strict();
const commercializationStageDetailSelectionSchema = z
  .object({
    module: z.literal("commercialization"),
    detail: z.literal("payment_stage"),
    stage: operationsPaymentLifecycleStageSchema,
    currency: operationsDetailCurrencySchema.optional(),
  })
  .strict();
const commercializationDetailSelectionSchema = z.union([
  commercializationRangeDetailSelectionSchema,
  commercializationFulfilledDetailSelectionSchema,
  commercializationStageDetailSelectionSchema,
]);
const contentRangeDetailSelectionSchema = z
  .object({
    module: z.literal("content"),
    detail: z.enum(["image_outputs", "video_outputs", "credit_usage"]),
  })
  .strict();
const contentBucketDetailSelectionSchema = z
  .object({
    module: z.literal("content"),
    detail: z.literal("content_bucket"),
    contentKind: z.enum(["image", "video", "credits"]),
    bucket: operationsDetailBucketSchema,
  })
  .strict();
const contentDetailSelectionSchema = z.union([
  contentRangeDetailSelectionSchema,
  contentBucketDetailSelectionSchema,
]);
/** 模块与明细种类的合法组合；拒绝把订单明细伪装成内容明细等跨域请求。 */
export const operationsDetailSelectionSchema = z.union([
  growthDetailSelectionSchema,
  commercializationDetailSelectionSchema,
  contentDetailSelectionSchema,
]);

export type OperationsDetailSelection = z.infer<
  typeof operationsDetailSelectionSchema
>;

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

/** 运营总览读取 operation 的输入；与页面查询共用同一严格范围契约。 */
export const operationsGetOverviewInputSchema =
  operationsDashboardQueryInputSchema;

/** 明细查询输入；selection、keyset 和页大小均由服务器 schema 限定。 */
export const operationsGetDetailInputSchema =
  operationsDashboardQueryInputSchema
    .extend({
      selection: operationsDetailSelectionSchema,
      cursor: operationsCursorSchema.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict();

/**
 * 运营快照的日期时间允许 Date 或带偏移 ISO 字符串。
 * WHY：Server Action 在 Node 进程内可能保留 Date，跨传输序列化后则为字符串；
 * 两种形态都属于同一只读快照，不在 schema 层改变业务时间。
 */
export const operationsDateTimeSchema = z.union([
  z.date(),
  z.string().datetime({ offset: true }),
]);

export type OperationsGetDetailInput = z.infer<
  typeof operationsGetDetailInputSchema
>;

/** 三类异步 CSV 导出的创建输入。 */
export const operationsCreateExportInputSchema = z
  .object({
    exportType: operationsExportTypeSchema,
    query: operationsDashboardQueryInputSchema,
    clientRequestId: z.string().trim().min(1).max(255),
  })
  .strict();

/** 导出任务状态机的稳定状态。 */
export const operationsExportStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "expired",
]);

/** 导出任务列表中的安全摘要；不暴露对象存储 key 或 lease token。 */
export const operationsExportTaskSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    exportType: operationsExportTypeSchema,
    status: operationsExportStatusSchema,
    query: operationsDashboardQueryInputSchema,
    createdAt: operationsDateTimeSchema,
    completedAt: operationsDateTimeSchema.nullable(),
    expiresAt: operationsDateTimeSchema.nullable(),
    rowCount: operationsCountSchema.nullable(),
    byteCount: operationsCountSchema.nullable(),
    errorCode: z.string().trim().min(1).max(100).nullable(),
    retryOfTaskId: z.string().trim().min(1).max(255).nullable(),
  })
  .strict();

export const operationsCreateExportOutputSchema = z
  .object({ task: operationsExportTaskSchema })
  .strict();

export const operationsListExportsInputSchema = z
  .object({
    cursor: operationsCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const operationsListExportsOutputSchema = z
  .object({
    tasks: z.array(operationsExportTaskSchema).max(101),
    nextCursor: operationsCursorSchema.nullable(),
  })
  .strict();

/** 失败任务重试输入；重试总是创建新任务并保留原任务记录。 */
export const operationsRetryExportInputSchema = z
  .object({
    taskId: z.string().trim().min(1).max(255),
    clientRequestId: z.string().trim().min(1).max(255),
  })
  .strict();

export const operationsRetryExportOutputSchema =
  operationsCreateExportOutputSchema;

/** 下载准备只返回短期许可，不把对象键或存储配置穿过 UOL。 */
export const operationsPrepareExportDownloadInputSchema = z
  .object({ taskId: z.string().trim().min(1).max(255) })
  .strict();

/** 本地受控下载路由的进程内 operation 与准备下载共用任务标识输入。 */
export const operationsOpenLocalExportDownloadInputSchema =
  operationsPrepareExportDownloadInputSchema;

export const operationsPrepareExportDownloadOutputSchema = z
  .object({
    taskId: z.string().trim().min(1).max(255),
    mode: z.enum(["redirect", "stream"]),
    downloadUrl: z.string().url().nullable(),
    expiresAt: operationsDateTimeSchema,
  })
  .strict();

/** 内部 worker 每次处理和清理的有界批次输入。 */
export const operationsProcessExportsInputSchema = z
  .object({ limit: z.number().int().min(1).max(100).default(10) })
  .strict();
export const operationsProcessExportsOutputSchema = z
  .object({ processed: operationsCountSchema })
  .strict();
export const operationsExpireExportsInputSchema =
  operationsProcessExportsInputSchema;
export const operationsExpireExportsOutputSchema =
  operationsProcessExportsOutputSchema;

export type OperationsGranularity = z.infer<typeof operationsGranularitySchema>;
export type OperationsDateRangeInput = z.infer<
  typeof operationsDateRangeInputSchema
>;
export type OperationsDashboardQueryInput = z.infer<
  typeof operationsDashboardQueryInputSchema
>;
export type OperationsExportType = z.infer<typeof operationsExportTypeSchema>;
export type OperationsExportTask = z.infer<typeof operationsExportTaskSchema>;
export type OperationsCreateExportInput = z.infer<
  typeof operationsCreateExportInputSchema
>;
export type OperationsRangeAvailability = z.infer<
  typeof operationsRangeAvailabilitySchema
>;
export type OperationsCurrencyAmount = z.infer<
  typeof operationsCurrencyAmountSchema
>;
