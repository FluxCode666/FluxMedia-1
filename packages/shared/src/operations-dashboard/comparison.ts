/**
 * 运营总览数量、比率、分币种金额比较和 Cohort 留存纯函数。
 *
 * 使用方：增长、商业化、内容与健康聚合服务。函数只处理已核对的精确数值，显式
 * 返回不可比较、上线前和未成熟状态，不将零分母转换成零、Infinity 或空字符串。
 */
import {
  type OperationsCurrencyAmount,
  type OperationsRangeAvailability,
  operationsCountSchema,
  operationsCurrencyAmountSchema,
} from "./contracts";
import { operationsAppDateSchema } from "./facts-contracts";
import { addOperationsCalendarDays } from "./range";

type ComparisonUnavailableReason =
  | "zero_previous"
  | "pre_epoch"
  | "zero_current_denominator"
  | "zero_previous_denominator";

export type CountComparison =
  | {
      status: "value";
      current: number;
      previous: number;
      changePercent: number;
    }
  | {
      status: "not_comparable";
      reason: Extract<
        ComparisonUnavailableReason,
        "zero_previous" | "pre_epoch"
      >;
      current: number;
      previous: number;
    };

/**
 * 比较当前和上一等长周期的数量。
 *
 * @param input 当前、上期数量和上期相对 epoch 的可用性。
 * @returns 上期完整且非零时给出百分比变化，否则显式不可比较。
 * @throws RangeError 当任一数量不是安全非负整数。
 */
export function compareCountValues(input: {
  current: number;
  previous: number;
  previousAvailability?: OperationsRangeAvailability;
}): CountComparison {
  if (
    !operationsCountSchema.safeParse(input.current).success ||
    !operationsCountSchema.safeParse(input.previous).success
  ) {
    throw new RangeError("比较数量必须是安全非负整数");
  }
  if (
    input.previousAvailability === "pre_epoch" ||
    input.previousAvailability === "partial_epoch"
  ) {
    return {
      status: "not_comparable",
      reason: "pre_epoch",
      current: input.current,
      previous: input.previous,
    };
  }
  if (input.previous === 0) {
    return {
      status: "not_comparable",
      reason: "zero_previous",
      current: input.current,
      previous: input.previous,
    };
  }
  return {
    status: "value",
    current: input.current,
    previous: input.previous,
    changePercent: ((input.current - input.previous) / input.previous) * 100,
  };
}

type RateFraction = { numerator: number; denominator: number };

export type RateComparison =
  | {
      status: "value";
      currentRate: number;
      previousRate: number;
      changePercentagePoints: number;
    }
  | {
      status: "not_comparable";
      reason: Extract<
        ComparisonUnavailableReason,
        "pre_epoch" | "zero_current_denominator" | "zero_previous_denominator"
      >;
    };

/**
 * 校验比率的分子、分母和集合关系。
 *
 * @param fraction 待比较的精确分子与分母。
 * @throws RangeError 当字段非法或分子大于分母。
 */
function assertValidRateFraction(fraction: RateFraction): void {
  if (
    !operationsCountSchema.safeParse(fraction.numerator).success ||
    !operationsCountSchema.safeParse(fraction.denominator).success ||
    fraction.numerator > fraction.denominator
  ) {
    throw new RangeError("比率分子分母无效");
  }
}

/**
 * 比较当前和上期比率并以百分点表达变化。
 *
 * @param input 当前与上期精确分子分母，以及上期 epoch 可用性。
 * @returns 两期分母有效时的百分点变化，否则显式不可比较。
 */
export function compareRateValues(input: {
  current: RateFraction;
  previous: RateFraction;
  previousAvailability?: OperationsRangeAvailability;
}): RateComparison {
  assertValidRateFraction(input.current);
  assertValidRateFraction(input.previous);
  if (
    input.previousAvailability === "pre_epoch" ||
    input.previousAvailability === "partial_epoch"
  ) {
    return { status: "not_comparable", reason: "pre_epoch" };
  }
  if (input.current.denominator === 0) {
    return {
      status: "not_comparable",
      reason: "zero_current_denominator",
    };
  }
  if (input.previous.denominator === 0) {
    return {
      status: "not_comparable",
      reason: "zero_previous_denominator",
    };
  }
  const currentRate = input.current.numerator / input.current.denominator;
  const previousRate = input.previous.numerator / input.previous.denominator;
  return {
    status: "value",
    currentRate,
    previousRate,
    changePercentagePoints: (currentRate - previousRate) * 100,
  };
}

export type CurrencyAmountComparison =
  | {
      status: "value";
      currency: string;
      currentAmountMinor: number;
      previousAmountMinor: number;
      changePercent: number;
    }
  | {
      status: "not_comparable";
      reason: "zero_previous" | "pre_epoch";
      currency: string;
      currentAmountMinor: number;
      previousAmountMinor: number;
    };

/**
 * 将金额数组校验并转换为唯一币种映射。
 *
 * @param values 单币种最小单位金额数组。
 * @returns 币种到金额的映射。
 * @throws RangeError 当金额非法或币种重复。
 */
function mapCurrencyAmounts(
  values: readonly OperationsCurrencyAmount[]
): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    const parsed = operationsCurrencyAmountSchema.safeParse(value);
    if (!parsed.success) throw new RangeError("币种金额无效");
    if (result.has(parsed.data.currency)) {
      throw new RangeError("币种金额不能重复");
    }
    result.set(parsed.data.currency, parsed.data.amountMinor);
  }
  return result;
}

/**
 * 按币种分别比较收入金额。
 *
 * @param input 当前、上期金额数组和上期 epoch 可用性。
 * @returns 币种字母序稳定的独立比较；缺失币种按真实零值处理。
 */
export function compareCurrencyAmounts(input: {
  current: readonly OperationsCurrencyAmount[];
  previous: readonly OperationsCurrencyAmount[];
  previousAvailability?: OperationsRangeAvailability;
}): CurrencyAmountComparison[] {
  const current = mapCurrencyAmounts(input.current);
  const previous = mapCurrencyAmounts(input.previous);
  const currencies = Array.from(
    new Set([...current.keys(), ...previous.keys()])
  ).sort();
  return currencies.map((currency) => {
    const currentAmountMinor = current.get(currency) ?? 0;
    const previousAmountMinor = previous.get(currency) ?? 0;
    const comparisonInput = {
      current: currentAmountMinor,
      previous: previousAmountMinor,
      ...(input.previousAvailability
        ? { previousAvailability: input.previousAvailability }
        : {}),
    };
    const comparison = compareCountValues(comparisonInput);
    if (comparison.status === "not_comparable") {
      return {
        status: comparison.status,
        reason: comparison.reason,
        currency,
        currentAmountMinor,
        previousAmountMinor,
      };
    }
    return {
      status: "value" as const,
      currency,
      currentAmountMinor,
      previousAmountMinor,
      changePercent: comparison.changePercent,
    };
  });
}

export type RetentionDay = 1 | 7 | 30;

export type CohortRetentionResult =
  | {
      status: "value";
      cohortDate: string;
      cohortSize: number;
      retainedCount: number;
      retentionDay: RetentionDay;
      maturityDate: string;
      rate: number;
    }
  | {
      status: "immature" | "pre_epoch" | "no_data";
      cohortDate: string;
      cohortSize: number;
      retainedCount: number;
      retentionDay: RetentionDay;
      maturityDate: string;
    };

/**
 * 解析单个注册 Cohort 在 D1、D7 或 D30 的成熟与精确留存状态。
 *
 * @param input 注册日、epoch、查询截点应用日期、人数和目标自然日差。
 * @returns epoch 前、尚未成熟、无 cohort 或含未格式化比率的成熟结果。
 * @throws RangeError 当日期、人数、目标天数或集合关系非法。
 */
export function resolveCohortRetention(input: {
  cohortDate: string;
  cohortSize: number;
  epochDate: string;
  retainedCount: number;
  retentionDay: RetentionDay;
  asOfDate: string;
}): CohortRetentionResult {
  for (const value of [input.cohortDate, input.epochDate, input.asOfDate]) {
    if (!operationsAppDateSchema.safeParse(value).success) {
      throw new RangeError("Cohort 日期无效");
    }
  }
  if (
    !operationsCountSchema.safeParse(input.cohortSize).success ||
    !operationsCountSchema.safeParse(input.retainedCount).success ||
    input.retainedCount > input.cohortSize
  ) {
    throw new RangeError("Cohort 人数无效");
  }
  if (![1, 7, 30].includes(input.retentionDay)) {
    throw new RangeError("留存目标日无效");
  }
  const maturityDate = addOperationsCalendarDays(
    input.cohortDate,
    input.retentionDay
  );
  const common = {
    cohortDate: input.cohortDate,
    cohortSize: input.cohortSize,
    retainedCount: input.retainedCount,
    retentionDay: input.retentionDay,
    maturityDate,
  };
  if (input.cohortDate < input.epochDate) {
    return { status: "pre_epoch", ...common };
  }
  if (maturityDate > input.asOfDate) {
    return { status: "immature", ...common };
  }
  if (input.cohortSize === 0) {
    return { status: "no_data", ...common };
  }
  return {
    status: "value",
    ...common,
    rate: input.retainedCount / input.cohortSize,
  };
}

export type WeightedRetentionSummary =
  | {
      status: "value";
      cohortCount: number;
      cohortSize: number;
      retainedCount: number;
      rate: number;
    }
  | { status: "immature" | "pre_epoch" };

/**
 * 按成熟 Cohort 人数加权汇总留存率。
 *
 * @param cohorts 同一 D1、D7 或 D30 口径下的逐日 Cohort 结果。
 * @returns 有成熟人口时以总留存人数除以总 cohort 人数；否则返回未成熟或上线前。
 */
export function summarizeWeightedRetention(
  cohorts: readonly CohortRetentionResult[]
): WeightedRetentionSummary {
  const mature = cohorts.filter(
    (cohort): cohort is Extract<CohortRetentionResult, { status: "value" }> =>
      cohort.status === "value"
  );
  if (mature.length === 0) {
    if (cohorts.length === 0) return { status: "immature" };
    const hasPostEpoch = cohorts.some(
      (cohort) => cohort.status === "immature" || cohort.status === "no_data"
    );
    return { status: hasPostEpoch ? "immature" : "pre_epoch" };
  }
  let cohortSize = 0;
  let retainedCount = 0;
  for (const cohort of mature) {
    cohortSize += cohort.cohortSize;
    retainedCount += cohort.retainedCount;
    if (
      !operationsCountSchema.safeParse(cohortSize).success ||
      !operationsCountSchema.safeParse(retainedCount).success
    ) {
      throw new RangeError("Cohort 加权人数超出安全整数范围");
    }
  }
  return {
    status: "value",
    cohortCount: mature.length,
    cohortSize,
    retainedCount,
    rate: retainedCount / cohortSize,
  };
}
