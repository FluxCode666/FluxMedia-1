/**
 * 运营总览 overview 与 detail 的严格 UOL 输出契约。
 *
 * 使用方：operation registry、Web binding、Server Action 与客户端明细解析。关键
 * 依赖为基础输入契约、范围日期和 Zod；本文件不依赖 apps/web，避免跨包反向引用。
 */
import { z } from "zod";

import {
  type OperationsDetailSelection,
  operationsCountSchema,
  operationsCreditValueSchema,
  operationsCurrencyAmountSchema,
  operationsCursorSchema,
  operationsDateTimeSchema,
  operationsDetailSelectionSchema,
  operationsGranularitySchema,
  operationsRangeAvailabilitySchema,
  operationsRateSchema,
} from "./contracts";
import { operationsAppDateSchema } from "./facts-contracts";

const finiteNumberSchema = z.number().finite();
const nonnegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();

/** 上一期等长范围的精确日期与 epoch 可用性。 */
export const operationsComparisonRangeOutputSchema = z
  .object({
    from: operationsAppDateSchema,
    to: operationsAppDateSchema,
    start: operationsDateTimeSchema,
    end: operationsDateTimeSchema,
    dayCount: operationsCountSchema,
    availability: operationsRangeAvailabilitySchema,
    dataStart: operationsDateTimeSchema.nullable(),
  })
  .strict();

/** 趋势单桶的精确自然日、UTC 边界与 epoch 可用性。 */
export const operationsRangeBucketOutputSchema = z
  .object({
    key: z.string().trim().min(1).max(255),
    granularity: operationsGranularitySchema,
    from: operationsAppDateSchema,
    to: operationsAppDateSchema,
    start: operationsDateTimeSchema,
    end: operationsDateTimeSchema,
    availability: operationsRangeAvailabilitySchema,
    dataFrom: operationsDateTimeSchema.nullable(),
  })
  .strict();

/** 当前查询解析后的完整应用时区范围。 */
export const operationsResolvedRangeOutputSchema = z
  .object({
    timeZone: z.string().trim().min(1).max(100),
    asOf: operationsDateTimeSchema,
    today: operationsAppDateSchema,
    epochDate: operationsAppDateSchema,
    granularity: operationsGranularitySchema,
    from: operationsAppDateSchema,
    to: operationsAppDateSchema,
    start: operationsDateTimeSchema,
    end: operationsDateTimeSchema,
    dayCount: operationsCountSchema,
    availability: operationsRangeAvailabilitySchema,
    dataStart: operationsDateTimeSchema.nullable(),
    previous: operationsComparisonRangeOutputSchema,
    buckets: z.array(operationsRangeBucketOutputSchema),
  })
  .strict();

const operationsCountComparisonSchema = z.union([
  z
    .object({
      status: z.literal("value"),
      current: operationsCountSchema,
      previous: operationsCountSchema,
      changePercent: finiteNumberSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("not_comparable"),
      reason: z.enum(["zero_previous", "pre_epoch"]),
      current: operationsCountSchema,
      previous: operationsCountSchema,
    })
    .strict(),
]);

const operationsRateComparisonSchema = z.union([
  z
    .object({
      status: z.literal("value"),
      currentRate: operationsRateSchema,
      previousRate: operationsRateSchema,
      changePercentagePoints: finiteNumberSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("not_comparable"),
      reason: z.enum([
        "pre_epoch",
        "zero_current_denominator",
        "zero_previous_denominator",
      ]),
    })
    .strict(),
]);

const operationsCurrencyComparisonSchema = z.union([
  z
    .object({
      status: z.literal("value"),
      currency: z.string().regex(/^[A-Z]{3}$/),
      currentAmountMinor: operationsCountSchema,
      previousAmountMinor: operationsCountSchema,
      changePercent: finiteNumberSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("not_comparable"),
      reason: z.enum(["zero_previous", "pre_epoch"]),
      currency: z.string().regex(/^[A-Z]{3}$/),
      currentAmountMinor: operationsCountSchema,
      previousAmountMinor: operationsCountSchema,
    })
    .strict(),
]);

const operationsNumericSeriesBucketSchema = z.union([
  operationsRangeBucketOutputSchema.extend({ status: z.literal("pre_epoch") }),
  operationsRangeBucketOutputSchema.extend({
    status: z.literal("value"),
    value: finiteNumberSchema,
  }),
]);

const operationsCountMetricSchema = z
  .object({
    status: z.enum(["value", "pre_epoch"]),
    current: operationsCountSchema,
    previous: operationsCountSchema,
    comparison: operationsCountComparisonSchema,
  })
  .strict();

const operationsCohortRetentionSchema = z.union([
  z
    .object({
      status: z.literal("value"),
      cohortDate: operationsAppDateSchema,
      cohortSize: operationsCountSchema,
      retainedCount: operationsCountSchema,
      retentionDay: z.union([z.literal(1), z.literal(7), z.literal(30)]),
      maturityDate: operationsAppDateSchema,
      rate: operationsRateSchema,
    })
    .strict(),
  z
    .object({
      status: z.enum(["immature", "pre_epoch", "no_data"]),
      cohortDate: operationsAppDateSchema,
      cohortSize: operationsCountSchema,
      retainedCount: operationsCountSchema,
      retentionDay: z.union([z.literal(1), z.literal(7), z.literal(30)]),
      maturityDate: operationsAppDateSchema,
    })
    .strict(),
]);

const operationsWeightedRetentionSchema = z.union([
  z
    .object({
      status: z.literal("value"),
      cohortCount: operationsCountSchema,
      cohortSize: operationsCountSchema,
      retainedCount: operationsCountSchema,
      rate: operationsRateSchema,
    })
    .strict(),
  z.object({ status: z.enum(["immature", "pre_epoch"]) }).strict(),
]);

const operationsRetentionMetricSchema = z
  .object({
    current: operationsWeightedRetentionSchema,
    previous: operationsWeightedRetentionSchema,
    comparison: z.union([
      operationsRateComparisonSchema,
      z
        .object({
          status: z.literal("not_comparable"),
          reason: z.literal("retention_unavailable"),
        })
        .strict(),
    ]),
  })
  .strict();

/** 用户增长、活跃、留存指标和趋势的完整输出。 */
export const operationsGrowthOutputSchema = z
  .object({
    generatedAt: operationsDateTimeSchema,
    range: operationsResolvedRangeOutputSchema,
    metrics: z
      .object({
        cumulativeUsers: operationsCountMetricSchema,
        newUsers: operationsCountMetricSchema,
        loginActiveUsers: operationsCountMetricSchema,
        creationActiveUsers: operationsCountMetricSchema,
        paymentActiveUsers: operationsCountMetricSchema,
        d1Retention: operationsRetentionMetricSchema,
        d7Retention: operationsRetentionMetricSchema,
        d30Retention: operationsRetentionMetricSchema,
      })
      .strict(),
    series: z
      .object({
        newUsers: z.array(operationsNumericSeriesBucketSchema),
        loginActiveUsers: z.array(operationsNumericSeriesBucketSchema),
        creationActiveUsers: z.array(operationsNumericSeriesBucketSchema),
        paymentActiveUsers: z.array(operationsNumericSeriesBucketSchema),
      })
      .strict(),
    cohorts: z.array(
      z
        .object({
          cohortDate: operationsAppDateSchema,
          cohortSize: operationsCountSchema,
          d1: operationsCohortRetentionSchema,
          d7: operationsCohortRetentionSchema,
          d30: operationsCohortRetentionSchema,
        })
        .strict()
    ),
  })
  .strict();

const operationsConversionValueSchema = z
  .object({
    paidUsers: operationsCountSchema,
    activeUsers: operationsCountSchema,
    rate: nonnegativeFiniteNumberSchema.nullable(),
  })
  .strict();

const operationsConversionComparisonSchema = z.union([
  z
    .object({
      status: z.literal("value"),
      currentRate: nonnegativeFiniteNumberSchema,
      previousRate: nonnegativeFiniteNumberSchema,
      changePercentagePoints: finiteNumberSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("not_comparable"),
      reason: z.enum([
        "pre_epoch",
        "zero_current_denominator",
        "zero_previous_denominator",
      ]),
    })
    .strict(),
]);

const operationsConversionMetricSchema = z
  .object({
    status: z.enum(["value", "pre_epoch"]),
    current: operationsConversionValueSchema,
    previous: operationsConversionValueSchema,
    comparison: operationsConversionComparisonSchema,
  })
  .strict();

/** 订单漏斗、分币种收入和双口径转化的完整输出。 */
export const operationsCommercialOutputSchema = z
  .object({
    generatedAt: operationsDateTimeSchema,
    range: operationsResolvedRangeOutputSchema,
    lifecycle: z
      .object({
        createdOrders: operationsCountMetricSchema,
        pendingOrders: operationsCountMetricSchema,
        paymentConfirmedOrders: operationsCountMetricSchema,
        paidNotFulfilledOrders: operationsCountMetricSchema,
        fulfilledOrders: operationsCountMetricSchema,
        failedOrders: operationsCountMetricSchema,
      })
      .strict(),
    revenue: z
      .object({
        status: z.enum(["value", "pre_epoch"]),
        current: z.array(operationsCurrencyAmountSchema),
        previous: z.array(operationsCurrencyAmountSchema),
        comparison: z.array(operationsCurrencyComparisonSchema),
        disclaimer: z.literal("不含线下退款"),
      })
      .strict(),
    conversion: z
      .object({
        fromCreation: operationsConversionMetricSchema,
        fromLogin: operationsConversionMetricSchema,
      })
      .strict(),
  })
  .strict();

const operationsCreditComparisonSchema = z.union([
  z
    .object({
      status: z.literal("value"),
      current: operationsCreditValueSchema,
      previous: operationsCreditValueSchema,
      changePercent: finiteNumberSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("not_comparable"),
      reason: z.enum(["zero_previous", "pre_epoch"]),
      current: operationsCreditValueSchema,
      previous: operationsCreditValueSchema,
    })
    .strict(),
]);

/** 成功图片、视频、视频秒数和净积分的完整输出。 */
export const operationsContentOutputSchema = z
  .object({
    generatedAt: operationsDateTimeSchema,
    range: operationsResolvedRangeOutputSchema,
    metrics: z
      .object({
        imageCount: operationsCountMetricSchema,
        videoCount: operationsCountMetricSchema,
        videoSeconds: operationsCountMetricSchema,
        netCredits: z
          .object({
            status: z.enum(["value", "pre_epoch"]),
            current: operationsCreditValueSchema,
            previous: operationsCreditValueSchema,
            comparison: operationsCreditComparisonSchema,
          })
          .strict(),
      })
      .strict(),
    series: z
      .object({
        imageCount: z.array(operationsNumericSeriesBucketSchema),
        videoCount: z.array(operationsNumericSeriesBucketSchema),
        videoSeconds: z.array(operationsNumericSeriesBucketSchema),
        netCredits: z.array(operationsNumericSeriesBucketSchema),
      })
      .strict(),
  })
  .strict();

const operationsTaskSuccessRateValueSchema = z.union([
  z
    .object({
      status: z.literal("value"),
      succeededTasks: operationsCountSchema,
      failedTasks: operationsCountSchema,
      rate: operationsRateSchema,
    })
    .strict(),
  z
    .object({
      status: z.enum(["no_data", "pre_epoch"]),
      succeededTasks: z.literal(0),
      failedTasks: z.literal(0),
      rate: z.null(),
    })
    .strict(),
]);

const operationsProcessingDurationValueSchema = z.union([
  z
    .object({
      status: z.literal("value"),
      sampleCount: operationsCountSchema,
      averageSeconds: nonnegativeFiniteNumberSchema,
      p95Seconds: nonnegativeFiniteNumberSchema,
    })
    .strict(),
  z
    .object({
      status: z.enum(["no_data", "pre_epoch"]),
      sampleCount: z.literal(0),
      averageSeconds: z.null(),
      p95Seconds: z.null(),
    })
    .strict(),
]);

const operationsFulfillmentFailureValueSchema = z
  .object({
    attemptFailures: operationsCountSchema,
    terminalFailures: operationsCountSchema,
    total: operationsCountSchema,
  })
  .strict();

/** 任务质量、履约失败、队列积压和后端健康的完整输出。 */
export const operationsSystemHealthOutputSchema = z
  .object({
    taskSuccessRate: z
      .object({
        current: operationsTaskSuccessRateValueSchema,
        previous: operationsTaskSuccessRateValueSchema,
        comparison: z.union([
          operationsRateComparisonSchema,
          z
            .object({
              status: z.literal("not_comparable"),
              reason: z.enum(["no_data", "pre_epoch"]),
            })
            .strict(),
        ]),
      })
      .strict(),
    processingDuration: z
      .object({
        current: operationsProcessingDurationValueSchema,
        previous: operationsProcessingDurationValueSchema,
      })
      .strict(),
    fulfillmentFailures: z
      .object({
        status: z.enum(["value", "pre_epoch"]),
        current: operationsFulfillmentFailureValueSchema,
        previous: operationsFulfillmentFailureValueSchema,
        comparison: operationsCountComparisonSchema,
      })
      .strict(),
    queueBacklog: z
      .object({
        status: z.literal("current"),
        imageQueued: operationsCountSchema,
        imageRunning: operationsCountSchema,
        videoPending: operationsCountSchema,
        total: operationsCountSchema,
      })
      .strict(),
    backendHealth: z
      .object({
        status: z.literal("current"),
        total: operationsCountSchema,
        enabled: operationsCountSchema,
        healthy: operationsCountSchema,
        degraded: operationsCountSchema,
        unhealthy: operationsCountSchema,
        cooling: operationsCountSchema,
        disabled: operationsCountSchema,
      })
      .strict(),
  })
  .strict();

/** 四个模块共用同一快照头的运营总览输出。 */
export const operationsOverviewOutputSchema = z
  .object({
    generatedAt: operationsDateTimeSchema,
    timeZone: z.string().trim().min(1).max(100),
    epoch: z
      .object({
        appDate: operationsAppDateSchema,
        startsAt: operationsDateTimeSchema,
      })
      .strict(),
    schemaVersion: z.literal(1),
    range: operationsResolvedRangeOutputSchema,
    growth: operationsGrowthOutputSchema,
    commercial: operationsCommercialOutputSchema,
    content: operationsContentOutputSchema,
    systemHealth: operationsSystemHealthOutputSchema,
  })
  .strict();

export type OperationsOverviewOutput = z.infer<
  typeof operationsOverviewOutputSchema
>;

export const operationsGrowthDetailRowSchema = z
  .object({
    userId: z.string().trim().min(1).max(512),
    name: z.string().max(512),
    email: z.string().email().max(512),
    role: z.string().trim().min(1).max(100),
    banned: z.boolean(),
    businessTime: operationsDateTimeSchema,
    retained: z.boolean().nullable(),
  })
  .strict();

export const operationsCommercialDetailRowSchema = z
  .object({
    paymentOrderId: z.string().trim().min(1).max(255),
    providerTradeNo: z.string().max(512).nullable(),
    userId: z.string().trim().min(1).max(512),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountMinor: operationsCountSchema,
    orderStatus: z.string().trim().min(1).max(100),
    createdAt: operationsDateTimeSchema,
    fulfilledAt: operationsDateTimeSchema.nullable(),
    businessTime: operationsDateTimeSchema,
    eventType: z.string().max(100).nullable(),
  })
  .strict();

export const operationsContentDetailRowSchema = z
  .object({
    taskId: z.string().trim().min(1).max(512),
    userId: z.string().trim().min(1).max(512),
    model: z.string().trim().min(1).max(512),
    mediaType: z.enum(["image", "video"]),
    businessTime: operationsDateTimeSchema,
    status: z.literal("completed"),
    quantity: operationsCountSchema.refine((value) => value > 0),
    videoSeconds: operationsCountSchema,
    netCredits: operationsCreditValueSchema,
  })
  .strict();

export const operationsDetailRowSchema = z.union([
  operationsGrowthDetailRowSchema,
  operationsCommercialDetailRowSchema,
  operationsContentDetailRowSchema,
]);

/** 判断一行是否匹配当前封闭 selection，并约束模块内部的关键判别字段。 */
function rowMatchesSelection(
  row: z.infer<typeof operationsDetailRowSchema>,
  selection: OperationsDetailSelection
): boolean {
  if (selection.module === "growth") {
    if (!("retained" in row)) return false;
    return selection.detail === "retention_cohorts"
      ? row.retained !== null
      : row.retained === null;
  }
  if (selection.module === "commercialization") {
    if (!("paymentOrderId" in row)) return false;
    return selection.detail === "orders" ||
      selection.detail === "fulfilled_orders"
      ? row.eventType === null
      : row.eventType !== null;
  }
  if (!("taskId" in row)) return false;
  if (selection.detail === "image_outputs") return row.mediaType === "image";
  if (selection.detail === "video_outputs") return row.mediaType === "video";
  return true;
}

/** 明细页输出；每一行都必须与 selection 的模块和明细种类一致。 */
export const operationsDetailOutputSchema = z
  .object({
    selection: operationsDetailSelectionSchema,
    range: operationsResolvedRangeOutputSchema,
    rows: z.array(operationsDetailRowSchema).max(501),
    nextCursor: operationsCursorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    value.rows.forEach((row, index) => {
      if (!rowMatchesSelection(row, value.selection)) {
        context.addIssue({
          code: "custom",
          message: "明细行与 selection 不匹配",
          path: ["rows", index],
        });
      }
    });
  });

export type OperationsDetailOutput = z.infer<
  typeof operationsDetailOutputSchema
>;

type AsyncByteIterableCandidate = {
  [Symbol.asyncIterator]?: unknown;
};

/** 验证进程内下载结果携带异步字节迭代器。 */
function isAsyncByteIterable(
  value: unknown
): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncByteIterableCandidate)[Symbol.asyncIterator] ===
      "function"
  );
}

/** 本地 CSV 下载只在 Next.js 同进程内传递，禁止序列化到 MCP 或外部传输。 */
export const operationsOpenLocalExportDownloadOutputSchema = z
  .object({
    taskId: z.string().trim().min(1).max(255),
    filename: z
      .string()
      .regex(/^operations-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.csv$/),
    contentType: z.literal("text/csv; charset=utf-8"),
    stream: z.custom<AsyncIterable<Uint8Array>>(isAsyncByteIterable),
  })
  .strict();

export type OperationsOpenLocalExportDownloadOutput = z.infer<
  typeof operationsOpenLocalExportDownloadOutputSchema
>;
