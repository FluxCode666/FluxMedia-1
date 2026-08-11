/**
 * 用户用量统计的唯一输入输出契约。
 *
 * UOL operation、Web 薄适配和 User MCP 必须复用这里的 Zod schema，避免范围、单位、
 * 字段可选性或身份边界漂移。本模块不接受 userId，也不读取数据库或运行时设置。
 */
import { z } from "zod";

export const analyticsGranularitySchema = z.enum(["hour", "day"]);
export const analyticsMetricSchema = z.enum(["imageCount", "videoSeconds"]);
export const analyticsMetricUnitSchema = z.enum(["images", "seconds"]);

const analyticsMetricWithDefaultSchema =
  analyticsMetricSchema.default("imageCount");
const localDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/,
    "必须使用 YYYY-MM-DDTHH:mm 格式"
  );
const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "必须使用 YYYY-MM-DD 格式");

const hourlyPresetInputSchema = z
  .object({
    granularity: z.literal("hour"),
    metric: analyticsMetricWithDefaultSchema,
    range: z.enum(["last24Hours", "last48Hours"]),
  })
  .strict();

const hourlyCustomInputSchema = z
  .object({
    granularity: z.literal("hour"),
    metric: analyticsMetricWithDefaultSchema,
    range: z.literal("custom"),
    start: localDateTimeSchema,
    end: localDateTimeSchema,
  })
  .strict();

const dailyPresetInputSchema = z
  .object({
    granularity: z.literal("day"),
    metric: analyticsMetricWithDefaultSchema,
    range: z.enum([
      "last7Days",
      "currentMonth",
      "currentQuarter",
      "currentYear",
    ]),
  })
  .strict();

const dailyCustomInputSchema = z
  .object({
    granularity: z.literal("day"),
    metric: analyticsMetricWithDefaultSchema,
    range: z.literal("custom"),
    start: localDateSchema,
    end: localDateSchema,
  })
  .strict();

export const usageTrendsInputSchema = z.union([
  hourlyPresetInputSchema,
  hourlyCustomInputSchema,
  dailyPresetInputSchema,
  dailyCustomInputSchema,
]);

const nonnegativeIntegerSchema = z.number().int().nonnegative();
const nonnegativeCreditsSchema = z.number().finite().nonnegative();
const isoDateTimeSchema = z.string().datetime({ offset: true });
const normalizedRangeSchema = z
  .object({
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
  })
  .strict();

const usageTotalsSchema = z
  .object({
    imageCount: nonnegativeIntegerSchema,
    videoSeconds: nonnegativeIntegerSchema,
    creditsConsumed: nonnegativeCreditsSchema,
  })
  .strict();

export const modelUsageItemSchema = z
  .object({
    model: z.string().trim().min(1).max(255),
    taskCount: nonnegativeIntegerSchema,
  })
  .strict();

export const modelUsageDistributionSchema = z
  .object({
    models: z.array(modelUsageItemSchema).max(1000),
    totalTasks: nonnegativeIntegerSchema,
  })
  .strict()
  .superRefine((distribution, context) => {
    const total = distribution.models.reduce(
      (sum, item) => sum + item.taskCount,
      0
    );
    if (total !== distribution.totalTasks) {
      context.addIssue({
        code: "custom",
        message: "模型任务数合计必须等于总任务数",
        path: ["totalTasks"],
      });
    }
  });

export const usageSummaryInputSchema = z.object({}).strict();

export const usageSummaryOutputSchema = z
  .object({
    asOf: isoDateTimeSchema,
    timeZone: z.string().min(1),
    last24HoursRange: normalizedRangeSchema,
    last24Hours: usageTotalsSchema,
    modelDistribution: modelUsageDistributionSchema,
    lifetime: usageTotalsSchema,
  })
  .strict();

export const usageSeriesBucketSchema = z
  .object({
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    label: z.string().min(1),
    value: nonnegativeIntegerSchema,
  })
  .strict();

export const usageTrendsOutputSchema = z
  .object({
    asOf: isoDateTimeSchema,
    timeZone: z.string().min(1),
    range: normalizedRangeSchema,
    granularity: analyticsGranularitySchema,
    metric: analyticsMetricSchema,
    unit: analyticsMetricUnitSchema,
    buckets: z.array(usageSeriesBucketSchema).max(366),
    distribution: z
      .object({
        imageTasks: nonnegativeIntegerSchema,
        videoTasks: nonnegativeIntegerSchema,
        totalTasks: nonnegativeIntegerSchema,
      })
      .strict(),
  })
  .strict();

export type AnalyticsGranularity = z.infer<typeof analyticsGranularitySchema>;
export type AnalyticsMetric = z.infer<typeof analyticsMetricSchema>;
export type AnalyticsMetricUnit = z.infer<typeof analyticsMetricUnitSchema>;
export type UsageTrendsInput = z.infer<typeof usageTrendsInputSchema>;
export type UsageSummaryOutput = z.infer<typeof usageSummaryOutputSchema>;
export type ModelUsageDistribution = z.infer<
  typeof modelUsageDistributionSchema
>;
export type UsageSeriesBucket = z.infer<typeof usageSeriesBucketSchema>;
export type UsageTrendsOutput = z.infer<typeof usageTrendsOutputSchema>;

export {
  DATA_DASHBOARD_DEFAULT_DAYS,
  DATA_DASHBOARD_MAX_DAYS,
  type AdminDataDashboardInput,
  type AdminDataDashboardUserOption,
  type AdminDataDashboardUserSearchInput,
  type AdminDataDashboardUserSearchOutput,
  type DataDashboardBucket,
  type DataDashboardInput,
  type DataDashboardOutput,
  adminDataDashboardInputSchema,
  adminDataDashboardUserOptionSchema,
  adminDataDashboardUserSearchInputSchema,
  adminDataDashboardUserSearchOutputSchema,
  dataDashboardBucketSchema,
  dataDashboardInputSchema,
  dataDashboardOutputSchema,
} from "./data-dashboard-contracts";
