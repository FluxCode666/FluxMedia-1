/**
 * 运营总览用户增长、活跃与精确创作留存领域服务。
 *
 * 使用方：后续 operations overview UOL binding。服务在一个数据库快照内解析
 * 公共日期契约，组装可比较指标、完整趋势桶、全量 Cohort 日行与加权留存。
 */
import {
  type CohortRetentionResult,
  type CountComparison,
  compareCountValues,
  compareRateValues,
  type RateComparison,
  type RetentionDay,
  resolveCohortRetention,
  summarizeWeightedRetention,
  type WeightedRetentionSummary,
} from "@repo/shared/operations-dashboard/comparison";
import type { OperationsDashboardQueryInput } from "@repo/shared/operations-dashboard/contracts";
import {
  addOperationsCalendarDays,
  type OperationsComparisonRange,
  type ResolvedOperationsDashboardRange,
  resolveOperationsDashboardRange,
} from "@repo/shared/operations-dashboard/range";
import {
  fillOperationsCountSeries,
  type OperationsNumericSeriesBucket,
} from "@repo/shared/operations-dashboard/series";
import { z } from "zod";

import {
  databaseOperationsGrowthRepository,
  type OperationsGrowthCohortQuery,
  type OperationsGrowthCohortRow,
  type OperationsGrowthRangeQuery,
  type OperationsGrowthRepository,
  type OperationsGrowthSeriesRow,
  type OperationsGrowthSnapshotReader,
} from "./growth-repository";

/** 增长服务对 UOL binding 暴露的稳定错误类别。 */
export type OperationsGrowthServiceErrorCode =
  | "validation_error"
  | "not_ready"
  | "invalid_data";

/** 不携带 SQL、邮箱或数据库行的增长领域错误。 */
export class OperationsGrowthServiceError extends Error {
  /** 创建可由 UOL binding 稳定映射的错误。 */
  constructor(
    readonly code: OperationsGrowthServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OperationsGrowthServiceError";
  }
}

/** 单个数量指标的当前值、上期值与对比状态。 */
export type OperationsGrowthCountMetric = {
  status: "value" | "pre_epoch";
  current: number;
  previous: number;
  comparison: CountComparison;
};

/** 单个 Cohort 日行的 D1、D7 和 D30 完整状态。 */
export type OperationsGrowthCohort = {
  cohortDate: string;
  cohortSize: number;
  d1: CohortRetentionResult;
  d7: CohortRetentionResult;
  d30: CohortRetentionResult;
};

/** 留存当期、上期与可比较状态。 */
export type OperationsGrowthRetentionMetric = {
  current: WeightedRetentionSummary;
  previous: WeightedRetentionSummary;
  comparison:
    | RateComparison
    | { status: "not_comparable"; reason: "retention_unavailable" };
};

/** 用户增长模块的完整快照。 */
export type OperationsGrowthSnapshot = {
  generatedAt: string;
  range: ResolvedOperationsDashboardRange;
  metrics: {
    cumulativeUsers: OperationsGrowthCountMetric;
    newUsers: OperationsGrowthCountMetric;
    loginActiveUsers: OperationsGrowthCountMetric;
    creationActiveUsers: OperationsGrowthCountMetric;
    paymentActiveUsers: OperationsGrowthCountMetric;
    d1Retention: OperationsGrowthRetentionMetric;
    d7Retention: OperationsGrowthRetentionMetric;
    d30Retention: OperationsGrowthRetentionMetric;
  };
  series: {
    newUsers: OperationsNumericSeriesBucket[];
    loginActiveUsers: OperationsNumericSeriesBucket[];
    creationActiveUsers: OperationsNumericSeriesBucket[];
    paymentActiveUsers: OperationsNumericSeriesBucket[];
  };
  cohorts: OperationsGrowthCohort[];
};

const databaseCountSchema = z.number().int().safe().nonnegative();

/** 复核内存仓储或数据库适配器返回的计数，防止损坏值进入比较。 */
function requireCount(value: number, field: string): number {
  if (!databaseCountSchema.safeParse(value).success) {
    throw new OperationsGrowthServiceError(
      "invalid_data",
      `${field}不是非负安全整数`
    );
  }
  return value;
}

/** 为一个可用范围读取非负整数；完全位于 epoch 前时返回缺失事实的中性 0。 */
async function readCountForAvailableRange(
  reader: OperationsGrowthSnapshotReader,
  range: { dataStart: Date | null; end: Date },
  read: (
    reader: OperationsGrowthSnapshotReader,
    input: OperationsGrowthRangeQuery
  ) => Promise<number>
): Promise<number> {
  if (!range.dataStart) return 0;
  return requireCount(
    await read(reader, { start: range.dataStart, end: range.end }),
    "增长指标"
  );
}

/** 根据当期与上期计数构造显式不可比较状态。 */
function createCountMetric(input: {
  current: number;
  previous: number;
  currentAvailability?: ResolvedOperationsDashboardRange["availability"];
  previousAvailability?: OperationsComparisonRange["availability"];
}): OperationsGrowthCountMetric {
  return {
    status: input.currentAvailability === "pre_epoch" ? "pre_epoch" : "value",
    current: input.current,
    previous: input.previous,
    comparison: compareCountValues(input),
  };
}

/** 将稀疏仓储行转成 shared series 填充器的稳定点。 */
function toSeriesPoints(
  rows: readonly OperationsGrowthSeriesRow[]
): Array<{ bucketKey: string; value: number }> {
  return rows.map((row) => ({
    bucketKey: row.bucketKey,
    value: requireCount(row.userCount, "趋势聚合值"),
  }));
}

/** 校验并索引仓储 Cohort 行，防止重复日或分子大于分母。 */
function indexCohortRows(
  rows: readonly OperationsGrowthCohortRow[],
  from: string,
  to: string
): ReadonlyMap<string, OperationsGrowthCohortRow> {
  const result = new Map<string, OperationsGrowthCohortRow>();
  for (const row of rows) {
    if (
      result.has(row.cohortDate) ||
      row.cohortDate < from ||
      row.cohortDate > to ||
      !databaseCountSchema.safeParse(row.cohortSize).success ||
      !databaseCountSchema.safeParse(row.retainedD1).success ||
      !databaseCountSchema.safeParse(row.retainedD7).success ||
      !databaseCountSchema.safeParse(row.retainedD30).success ||
      row.retainedD1 > row.cohortSize ||
      row.retainedD7 > row.cohortSize ||
      row.retainedD30 > row.cohortSize
    ) {
      throw new OperationsGrowthServiceError(
        "invalid_data",
        "Cohort 聚合结果无效"
      );
    }
    result.set(row.cohortDate, row);
  }
  return result;
}

/**
 * 将全量日期与稀疏 SQL 结果合并成可区分上线前、未成熟和真实零值的矩阵。
 *
 * @failure 尽管自定义趋势不限跨度，Cohort 产品契约要求不分页保留全部注册
 * 自然日；这可能产生大数组，属于显式产品边界，不在服务层隐式截断。
 */
function buildCohortMatrix(input: {
  from: string;
  to: string;
  epochDate: string;
  asOfDate: string;
  rows: readonly OperationsGrowthCohortRow[];
}): OperationsGrowthCohort[] {
  const indexed = indexCohortRows(input.rows, input.from, input.to);
  const cohorts: OperationsGrowthCohort[] = [];
  let cohortDate = input.from;
  while (cohortDate <= input.to) {
    const row = indexed.get(cohortDate);
    const cohortSize = row?.cohortSize ?? 0;
    const createRetention = (
      retentionDay: RetentionDay,
      retainedCount: number
    ): CohortRetentionResult =>
      resolveCohortRetention({
        cohortDate,
        cohortSize,
        epochDate: input.epochDate,
        asOfDate: input.asOfDate,
        retentionDay,
        retainedCount,
      });
    cohorts.push({
      cohortDate,
      cohortSize,
      d1: createRetention(1, row?.retainedD1 ?? 0),
      d7: createRetention(7, row?.retainedD7 ?? 0),
      d30: createRetention(30, row?.retainedD30 ?? 0),
    });
    cohortDate = addOperationsCalendarDays(cohortDate, 1);
  }
  return cohorts;
}

/** 查询一个注册范围内的 Cohort 聚合；范围全在 epoch 前时避免无意义 SQL。 */
async function readCohortRows(
  reader: OperationsGrowthSnapshotReader,
  input: OperationsGrowthCohortQuery,
  hasAvailableDates: boolean
): Promise<OperationsGrowthCohortRow[]> {
  return hasAvailableDates ? reader.readCohorts(input) : [];
}

/** 构造当期与上期加权留存及其百分点对比。 */
function createRetentionMetric(
  currentCohorts: readonly OperationsGrowthCohort[],
  previousCohorts: readonly OperationsGrowthCohort[],
  key: "d1" | "d7" | "d30",
  previousAvailability: OperationsComparisonRange["availability"]
): OperationsGrowthRetentionMetric {
  const current = summarizeWeightedRetention(
    currentCohorts.map((cohort) => cohort[key])
  );
  const previous = summarizeWeightedRetention(
    previousCohorts.map((cohort) => cohort[key])
  );
  if (current.status !== "value" || previous.status !== "value") {
    return {
      current,
      previous,
      comparison: {
        status: "not_comparable",
        reason: "retention_unavailable",
      },
    };
  }
  return {
    current,
    previous,
    comparison: compareRateValues({
      current: {
        numerator: current.retainedCount,
        denominator: current.cohortSize,
      },
      previous: {
        numerator: previous.retainedCount,
        denominator: previous.cohortSize,
      },
      previousAvailability,
    }),
  };
}

/**
 * 使用已绑定到调用方事务的 reader 组装用户增长快照。
 *
 * @param input 已由共享 strict schema 定义的范围与趋势粒度。
 * @param timeZone 服务端应用时区，不接受客户端覆盖。
 * @param reader 已绑定到同一只读数据库事务的增长 reader。
 * @returns 含特殊状态、对比、完整趋势与 Cohort 矩阵的快照。
 * @sideEffects 只读 reader，不开启事务也不写入业务事实。
 * @failure epoch 未初始化返回 not_ready；范围或数据异常显式失败。
 */
export async function buildOperationsGrowthSnapshot(
  input: OperationsDashboardQueryInput | unknown,
  timeZone: string,
  reader: OperationsGrowthSnapshotReader
): Promise<OperationsGrowthSnapshot> {
  const header = await reader.readHeader();
  if (!header.epoch) {
    throw new OperationsGrowthServiceError(
      "not_ready",
      "运营统计起点尚未初始化"
    );
  }
  const epoch = header.epoch;
  let range: ResolvedOperationsDashboardRange;
  try {
    range = resolveOperationsDashboardRange(input, {
      timeZone,
      asOf: header.asOf,
      epochDate: epoch.appDate,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new OperationsGrowthServiceError(
        "validation_error",
        "运营总览查询范围无效"
      );
    }
    throw error;
  }

  const currentRange = { dataStart: range.dataStart, end: range.end };
  const previousRange = {
    dataStart: range.previous.dataStart,
    end: range.previous.end,
  };
  const readNewUsers = (
    targetReader: OperationsGrowthSnapshotReader,
    targetRange: OperationsGrowthRangeQuery
  ) => targetReader.readNewUserCount(targetRange);
  const readActivity =
    (kind: "login" | "creation" | "payment") =>
    (
      targetReader: OperationsGrowthSnapshotReader,
      targetRange: OperationsGrowthRangeQuery
    ) =>
      targetReader.readActivityUserCount(kind, targetRange);

  const cumulativeUsers = requireCount(
    await reader.readCumulativeUserCount(range.end),
    "累计用户"
  );
  const previousCumulativeUsers = requireCount(
    await reader.readCumulativeUserCount(range.previous.end),
    "上期累计用户"
  );
  const newUsers = await readCountForAvailableRange(
    reader,
    currentRange,
    readNewUsers
  );
  const previousNewUsers = await readCountForAvailableRange(
    reader,
    previousRange,
    readNewUsers
  );
  const loginActiveUsers = await readCountForAvailableRange(
    reader,
    currentRange,
    readActivity("login")
  );
  const previousLoginActiveUsers = await readCountForAvailableRange(
    reader,
    previousRange,
    readActivity("login")
  );
  const creationActiveUsers = await readCountForAvailableRange(
    reader,
    currentRange,
    readActivity("creation")
  );
  const previousCreationActiveUsers = await readCountForAvailableRange(
    reader,
    previousRange,
    readActivity("creation")
  );
  const paymentActiveUsers = await readCountForAvailableRange(
    reader,
    currentRange,
    readActivity("payment")
  );
  const previousPaymentActiveUsers = await readCountForAvailableRange(
    reader,
    previousRange,
    readActivity("payment")
  );

  const newUserRows = await reader.readNewUserSeries(range.buckets);
  const loginRows = await reader.readActivitySeries("login", range.buckets);
  const creationRows = await reader.readActivitySeries(
    "creation",
    range.buckets
  );
  const paymentRows = await reader.readActivitySeries("payment", range.buckets);

  const currentRawCohorts = await readCohortRows(
    reader,
    {
      start: range.dataStart ?? range.start,
      end: range.end,
      epochStart: epoch.startsAt,
      asOf: range.asOf,
      timeZone: range.timeZone,
    },
    range.dataStart !== null
  );
  const previousRawCohorts = await readCohortRows(
    reader,
    {
      start: range.previous.dataStart ?? range.previous.start,
      end: range.previous.end,
      epochStart: epoch.startsAt,
      asOf: range.asOf,
      timeZone: range.timeZone,
    },
    range.previous.dataStart !== null
  );
  const cohorts = buildCohortMatrix({
    from: range.from,
    to: range.to,
    epochDate: range.epochDate,
    asOfDate: range.today,
    rows: currentRawCohorts,
  });
  const previousCohorts = buildCohortMatrix({
    from: range.previous.from,
    to: range.previous.to,
    epochDate: range.epochDate,
    asOfDate: range.today,
    rows: previousRawCohorts,
  });

  const comparisonAvailability = range.previous.availability;
  return {
    generatedAt: range.asOf.toISOString(),
    range,
    metrics: {
      cumulativeUsers: createCountMetric({
        current: cumulativeUsers,
        previous: previousCumulativeUsers,
      }),
      newUsers: createCountMetric({
        current: newUsers,
        previous: previousNewUsers,
        currentAvailability: range.availability,
        previousAvailability: comparisonAvailability,
      }),
      loginActiveUsers: createCountMetric({
        current: loginActiveUsers,
        previous: previousLoginActiveUsers,
        currentAvailability: range.availability,
        previousAvailability: comparisonAvailability,
      }),
      creationActiveUsers: createCountMetric({
        current: creationActiveUsers,
        previous: previousCreationActiveUsers,
        currentAvailability: range.availability,
        previousAvailability: comparisonAvailability,
      }),
      paymentActiveUsers: createCountMetric({
        current: paymentActiveUsers,
        previous: previousPaymentActiveUsers,
        currentAvailability: range.availability,
        previousAvailability: comparisonAvailability,
      }),
      d1Retention: createRetentionMetric(
        cohorts,
        previousCohorts,
        "d1",
        comparisonAvailability
      ),
      d7Retention: createRetentionMetric(
        cohorts,
        previousCohorts,
        "d7",
        comparisonAvailability
      ),
      d30Retention: createRetentionMetric(
        cohorts,
        previousCohorts,
        "d30",
        comparisonAvailability
      ),
    },
    series: {
      newUsers: fillOperationsCountSeries(
        range.buckets,
        toSeriesPoints(newUserRows)
      ),
      loginActiveUsers: fillOperationsCountSeries(
        range.buckets,
        toSeriesPoints(loginRows)
      ),
      creationActiveUsers: fillOperationsCountSeries(
        range.buckets,
        toSeriesPoints(creationRows)
      ),
      paymentActiveUsers: fillOperationsCountSeries(
        range.buckets,
        toSeriesPoints(paymentRows)
      ),
    },
    cohorts,
  };
}

/**
 * 读取用户增长模块的独立一致快照。
 *
 * @param input 已由共享 strict schema 定义的范围与趋势粒度。
 * @param timeZone 服务端应用时区，不接受客户端覆盖。
 * @param repository 可注入的只读快照仓储。
 * @returns 含特殊状态、对比、完整趋势与 Cohort 矩阵的快照。
 * @sideEffects 仅开启一次只读 repeatable-read 事务。
 */
export async function loadOperationsGrowthSnapshot(
  input: OperationsDashboardQueryInput | unknown,
  timeZone: string,
  repository: OperationsGrowthRepository = databaseOperationsGrowthRepository
): Promise<OperationsGrowthSnapshot> {
  return repository.withReadOnlySnapshot((reader) =>
    buildOperationsGrowthSnapshot(input, timeZone, reader)
  );
}
