/**
 * 运营总览内容生产领域服务。
 *
 * 使用方：后续 operations overview UOL binding。服务门禁 output_usage 与
 * credit_usage v1 readiness，在同一快照内生成图片、视频数量/秒数和成功业务
 * 净积分的完整趋势、当期汇总及上一等长周期比较。
 */
import {
  type CountComparison,
  compareCountValues,
} from "@repo/shared/operations-dashboard/comparison";
import type {
  OperationsDashboardQueryInput,
  OperationsRangeAvailability,
} from "@repo/shared/operations-dashboard/contracts";
import {
  type OperationsRangeBucket,
  type ResolvedOperationsDashboardRange,
  resolveOperationsDashboardRange,
} from "@repo/shared/operations-dashboard/range";
import {
  fillOperationsCountSeries,
  fillOperationsCreditSeries,
  type OperationsNumericSeriesBucket,
} from "@repo/shared/operations-dashboard/series";
import { z } from "zod";

import {
  databaseOperationsContentRepository,
  type OperationsContentRepository,
  type OperationsContentSeriesRow,
  type OperationsContentSnapshotHeader,
  type OperationsContentSnapshotReader,
} from "./content-repository";
import type { OperationsGrowthBucketQuery } from "./growth-repository";

/** 内容生产服务对 UOL binding 暴露的稳定错误类别。 */
export type OperationsContentServiceErrorCode =
  | "validation_error"
  | "not_ready"
  | "invalid_data";

/** 不携带 SQL、任务内容或数据库行的内容生产领域错误。 */
export class OperationsContentServiceError extends Error {
  /** 创建可由 UOL binding 稳定映射的错误。 */
  constructor(
    readonly code: OperationsContentServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OperationsContentServiceError";
  }
}

/** 内容数量指标的当前值、上期值和百分比比较。 */
export type OperationsContentCountMetric = {
  status: "value" | "pre_epoch";
  current: number;
  previous: number;
  comparison: CountComparison;
};

/** 成功业务净积分的百分比比较状态。 */
export type OperationsContentCreditComparison =
  | {
      status: "value";
      current: number;
      previous: number;
      changePercent: number;
    }
  | {
      status: "not_comparable";
      reason: "zero_previous" | "pre_epoch";
      current: number;
      previous: number;
    };

/** 净积分指标保留两位小数值及显式不可比较状态。 */
export type OperationsContentCreditMetric = {
  status: "value" | "pre_epoch";
  current: number;
  previous: number;
  comparison: OperationsContentCreditComparison;
};

/** 运营总览内容生产模块的完整快照。 */
export type OperationsContentSnapshot = {
  generatedAt: string;
  range: ResolvedOperationsDashboardRange;
  metrics: {
    imageCount: OperationsContentCountMetric;
    videoCount: OperationsContentCountMetric;
    videoSeconds: OperationsContentCountMetric;
    netCredits: OperationsContentCreditMetric;
  };
  series: {
    imageCount: OperationsNumericSeriesBucket[];
    videoCount: OperationsNumericSeriesBucket[];
    videoSeconds: OperationsNumericSeriesBucket[];
    netCredits: OperationsNumericSeriesBucket[];
  };
};

type NormalizedContentSeries = OperationsContentSnapshot["series"];

const databaseCountSchema = z.number().int().safe().nonnegative();

/** 校验快照头、epoch 与两个读模型均达到 v1 ready。 */
function assertContentReadiness(
  header: OperationsContentSnapshotHeader
): asserts header is OperationsContentSnapshotHeader & {
  epoch: NonNullable<OperationsContentSnapshotHeader["epoch"]>;
} {
  if (!header.epoch) {
    throw new OperationsContentServiceError(
      "not_ready",
      "运营统计起点尚未初始化"
    );
  }
  if (
    header.outputUsage?.version !== 1 ||
    header.outputUsage.status !== "ready" ||
    header.creditUsage?.version !== 1 ||
    header.creditUsage.status !== "ready"
  ) {
    throw new OperationsContentServiceError(
      "not_ready",
      "内容生产统计仍在准备中"
    );
  }
  if (Number.isNaN(header.asOf.getTime())) {
    throw new OperationsContentServiceError(
      "invalid_data",
      "内容生产快照时间无效"
    );
  }
}

/** 校验数据库计数，避免损坏数值进入序列与汇总。 */
function requireCount(value: number, field: string): number {
  if (!databaseCountSchema.safeParse(value).success) {
    throw new OperationsContentServiceError(
      "invalid_data",
      `${field}不是非负安全整数`
    );
  }
  return value;
}

/** 将数据库内容行转换成四条完整、同桶的领域趋势。 */
function normalizeContentSeries(
  buckets: readonly OperationsRangeBucket[],
  rows: readonly OperationsContentSeriesRow[]
): NormalizedContentSeries {
  const normalizedRows = rows.map((row) => {
    const mismatchCount = requireCount(
      row.operationCreatedAtMismatchCount,
      "计费时间漂移数"
    );
    if (mismatchCount !== 0) {
      throw new OperationsContentServiceError(
        "invalid_data",
        "成功产物与计费 operation 的业务创建时间不一致"
      );
    }
    return {
      bucketKey: row.bucketKey,
      imageCount: requireCount(row.imageCount, "成功图片数"),
      videoCount: requireCount(row.videoCount, "成功视频数"),
      videoSeconds: requireCount(row.videoSeconds, "成功视频秒数"),
      creditHundredths: requireCount(
        row.creditHundredths,
        "成功积分百分位净用量"
      ),
    };
  });
  try {
    return {
      imageCount: fillOperationsCountSeries(
        buckets,
        normalizedRows.map((row) => ({
          bucketKey: row.bucketKey,
          value: row.imageCount,
        }))
      ),
      videoCount: fillOperationsCountSeries(
        buckets,
        normalizedRows.map((row) => ({
          bucketKey: row.bucketKey,
          value: row.videoCount,
        }))
      ),
      videoSeconds: fillOperationsCountSeries(
        buckets,
        normalizedRows.map((row) => ({
          bucketKey: row.bucketKey,
          value: row.videoSeconds,
        }))
      ),
      netCredits: fillOperationsCreditSeries(
        buckets,
        normalizedRows.map((row) => ({
          bucketKey: row.bucketKey,
          value: row.creditHundredths / 100,
        }))
      ),
    };
  } catch (error) {
    if (error instanceof RangeError) {
      throw new OperationsContentServiceError(
        "invalid_data",
        "内容生产趋势聚合结果无效"
      );
    }
    throw error;
  }
}

/** 从完整数量序列归并非上线前桶，并保持安全整数边界。 */
function sumCountSeries(
  series: readonly OperationsNumericSeriesBucket[]
): number {
  return series.reduce(
    (total, point) =>
      point.status === "value"
        ? requireCount(total + point.value, "内容数量合计")
        : total,
    0
  );
}

/** 从完整积分序列按百分之一积分归并，避免二进制浮点累计漂移。 */
function sumCreditSeries(
  series: readonly OperationsNumericSeriesBucket[]
): number {
  const hundredths = series.reduce((total, point) => {
    if (point.status !== "value") return total;
    return requireCount(
      total + Math.round(point.value * 100),
      "成功积分百分位合计"
    );
  }, 0);
  return hundredths / 100;
}

/** 为当前与上期数量建立状态和标准百分比比较。 */
function createCountMetric(input: {
  current: number;
  previous: number;
  currentAvailability: OperationsRangeAvailability;
  previousAvailability: OperationsRangeAvailability;
}): OperationsContentCountMetric {
  return {
    status: input.currentAvailability === "pre_epoch" ? "pre_epoch" : "value",
    current: input.current,
    previous: input.previous,
    comparison: compareCountValues({
      current: input.current,
      previous: input.previous,
      previousAvailability: input.previousAvailability,
    }),
  };
}

/** 以百分之一积分精确比较当期和上期净用量。 */
function createCreditMetric(input: {
  current: number;
  previous: number;
  currentAvailability: OperationsRangeAvailability;
  previousAvailability: OperationsRangeAvailability;
}): OperationsContentCreditMetric {
  const base = {
    current: input.current,
    previous: input.previous,
  };
  let comparison: OperationsContentCreditComparison;
  if (input.previousAvailability !== "available") {
    comparison = { status: "not_comparable", reason: "pre_epoch", ...base };
  } else if (input.previous === 0) {
    comparison = {
      status: "not_comparable",
      reason: "zero_previous",
      ...base,
    };
  } else {
    comparison = {
      status: "value",
      ...base,
      changePercent: ((input.current - input.previous) / input.previous) * 100,
    };
  }
  return {
    status: input.currentAvailability === "pre_epoch" ? "pre_epoch" : "value",
    ...base,
    comparison,
  };
}

/** 使用同一范围解析规则构造上一等长周期的完整趋势桶。 */
function resolvePreviousRange(
  range: ResolvedOperationsDashboardRange
): ResolvedOperationsDashboardRange {
  return resolveOperationsDashboardRange(
    {
      granularity: range.granularity,
      range: {
        kind: "custom",
        from: range.previous.from,
        to: range.previous.to,
      },
    },
    {
      timeZone: range.timeZone,
      asOf: range.asOf,
      epochDate: range.epochDate,
    }
  );
}

/** 仅在范围包含 epoch 后事实时读取稀疏内容趋势。 */
async function readSeriesWhenAvailable(
  reader: OperationsContentSnapshotReader,
  buckets: readonly OperationsGrowthBucketQuery[]
): Promise<OperationsContentSeriesRow[]> {
  return buckets.some((bucket) => bucket.dataFrom !== null)
    ? reader.readSeries(buckets)
    : [];
}

/**
 * 使用调用方提供的 reader 组装内容生产快照。
 *
 * @sideEffects 只读取 reader，不提交事务或修改任务、积分事实。
 * @failure epoch/read-model 未就绪、范围非法或聚合数据损坏时抛稳定领域错误。
 */
export async function buildOperationsContentSnapshot(
  input: OperationsDashboardQueryInput | unknown,
  timeZone: string,
  reader: OperationsContentSnapshotReader
): Promise<OperationsContentSnapshot> {
  const header = await reader.readHeader();
  assertContentReadiness(header);

  let range: ResolvedOperationsDashboardRange;
  let previousRange: ResolvedOperationsDashboardRange;
  try {
    range = resolveOperationsDashboardRange(input, {
      timeZone,
      asOf: header.asOf,
      epochDate: header.epoch.appDate,
    });
    previousRange = resolvePreviousRange(range);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new OperationsContentServiceError(
        "validation_error",
        "运营总览查询范围无效"
      );
    }
    throw error;
  }

  const [currentRows, previousRows] = await Promise.all([
    readSeriesWhenAvailable(reader, range.buckets),
    readSeriesWhenAvailable(reader, previousRange.buckets),
  ]);
  const currentSeries = normalizeContentSeries(range.buckets, currentRows);
  const previousSeries = normalizeContentSeries(
    previousRange.buckets,
    previousRows
  );
  const metricInput = {
    currentAvailability: range.availability,
    previousAvailability: range.previous.availability,
  };

  return {
    generatedAt: header.asOf.toISOString(),
    range,
    metrics: {
      imageCount: createCountMetric({
        ...metricInput,
        current: sumCountSeries(currentSeries.imageCount),
        previous: sumCountSeries(previousSeries.imageCount),
      }),
      videoCount: createCountMetric({
        ...metricInput,
        current: sumCountSeries(currentSeries.videoCount),
        previous: sumCountSeries(previousSeries.videoCount),
      }),
      videoSeconds: createCountMetric({
        ...metricInput,
        current: sumCountSeries(currentSeries.videoSeconds),
        previous: sumCountSeries(previousSeries.videoSeconds),
      }),
      netCredits: createCreditMetric({
        ...metricInput,
        current: sumCreditSeries(currentSeries.netCredits),
        previous: sumCreditSeries(previousSeries.netCredits),
      }),
    },
    series: currentSeries,
  };
}

/**
 * 读取内容生产模块的独立一致快照。
 *
 * @sideEffects 仅开启只读 repeatable-read 事务。
 * @failure epoch/read-model 未就绪、范围非法或仓储数据损坏时抛稳定领域错误。
 */
export async function loadOperationsContentSnapshot(
  input: OperationsDashboardQueryInput | unknown,
  timeZone: string,
  repository: OperationsContentRepository = databaseOperationsContentRepository
): Promise<OperationsContentSnapshot> {
  return repository.withReadOnlySnapshot((reader) =>
    buildOperationsContentSnapshot(input, timeZone, reader)
  );
}
