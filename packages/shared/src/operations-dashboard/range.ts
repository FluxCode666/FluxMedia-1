/**
 * 运营总览应用时区日期范围、上一等长周期和完整日周月桶纯函数。
 *
 * 使用方：overview、detail、CSV 和 Cohort 服务。所有本地日期统一转为 UTC 半开区间；
 * 今天截止调用方捕获的同一 asOf，周固定以周一开始，数据库与系统时区不会参与计算。
 */
import {
  formatDateInputInTimeZone,
  isValidTimeZone,
  parseDateInputInTimeZone,
} from "../time-zone";
import {
  OPERATIONS_DASHBOARD_DEFAULT_DAYS,
  type OperationsDashboardQueryInput,
  type OperationsGranularity,
  type OperationsRangeAvailability,
  operationsDashboardQueryInputSchema,
} from "./contracts";
import { operationsAppDateSchema } from "./facts-contracts";

const DAY_MS = 86_400_000;

export type OperationsRangeBucket = {
  key: string;
  granularity: OperationsGranularity;
  from: string;
  to: string;
  start: Date;
  end: Date;
  availability: OperationsRangeAvailability;
  dataFrom: Date | null;
};

export type OperationsComparisonRange = {
  from: string;
  to: string;
  start: Date;
  end: Date;
  dayCount: number;
  availability: OperationsRangeAvailability;
  dataStart: Date | null;
};

export type ResolvedOperationsDashboardRange = {
  timeZone: string;
  asOf: Date;
  today: string;
  epochDate: string;
  granularity: OperationsGranularity;
  from: string;
  to: string;
  start: Date;
  end: Date;
  dayCount: number;
  availability: OperationsRangeAvailability;
  dataStart: Date | null;
  previous: OperationsComparisonRange;
  buckets: OperationsRangeBucket[];
};

export type ResolveOperationsDashboardRangeOptions = {
  timeZone: string;
  asOf: Date;
  epochDate: string;
};

/**
 * 将合法 Gregorian 日期移动指定自然日数。
 *
 * @param value 已通过日期 schema 的 YYYY-MM-DD。
 * @param days 可正可负的整数自然日数。
 * @returns 移动后的 YYYY-MM-DD；不受运行环境时区和 DST 影响。
 */
export function addOperationsCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * 计算首尾包含的 Gregorian 自然日数量。
 *
 * @param from 起始日期。
 * @param to 结束日期。
 * @returns 正向范围的 inclusive 天数，反向范围返回非正数。
 */
function countInclusiveDays(from: string, to: string): number {
  return (
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) -
        Date.parse(`${from}T00:00:00.000Z`)) /
        DAY_MS
    ) + 1
  );
}

/**
 * 将合法应用日期解析为指定时区零点。
 *
 * @param value 已校验日期。
 * @param timeZone 已校验 IANA 时区。
 * @returns 对应 UTC 瞬间。
 * @throws RangeError 当运行时无法映射日期边界。
 */
function requireDateStart(value: string, timeZone: string): Date {
  const parsed = parseDateInputInTimeZone(value, { timeZone });
  if (!parsed) throw new RangeError("无法解析应用时区自然日边界");
  return parsed;
}

/**
 * 返回日期所在自然周的周一。
 *
 * @param value 合法 Gregorian 日期。
 * @returns 同周周一日期；无时区副作用。
 */
function getMonday(value: string): string {
  const day = new Date(`${value}T00:00:00.000Z`).getUTCDay();
  return addOperationsCalendarDays(value, -(day === 0 ? 6 : day - 1));
}

/**
 * 返回日期所在自然月的第一天。
 *
 * @param value 合法 Gregorian 日期。
 * @returns YYYY-MM-01；无副作用。
 */
function getMonthStart(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

/**
 * 返回某月首日的下一月首日。
 *
 * @param monthStart 合法自然月第一天。
 * @returns 下一自然月第一天；正确处理年边界。
 */
function getNextMonthStart(monthStart: string): string {
  const date = new Date(`${monthStart}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * 判断日期区间相对生产 epoch 的事实可用性。
 *
 * @param from 区间首日。
 * @param to 区间末日。
 * @param epochDate 首个有行为事实的应用日期。
 * @returns 完全可用、跨 epoch 部分可用或完全位于 epoch 前。
 */
function resolveAvailability(
  from: string,
  to: string,
  epochDate: string
): OperationsRangeAvailability {
  if (to < epochDate) return "pre_epoch";
  return from < epochDate ? "partial_epoch" : "available";
}

/**
 * 计算范围真正允许读取行为事实的 UTC 起点。
 *
 * @param from 选择范围首日。
 * @param to 选择范围末日。
 * @param epochDate 首个有行为事实的应用日期。
 * @param timeZone 已校验应用时区。
 * @returns 完全位于 epoch 前时为 null，跨 epoch 时为 epoch 零点，否则为范围零点。
 */
function resolveDataStart(
  from: string,
  to: string,
  epochDate: string,
  timeZone: string
): Date | null {
  const availability = resolveAvailability(from, to, epochDate);
  if (availability === "pre_epoch") return null;
  return requireDateStart(from < epochDate ? epochDate : from, timeZone);
}

/**
 * 根据快捷项或自定义输入规范化闭区间日期。
 *
 * @param input 已通过 strict schema 的查询输入。
 * @param today 应用时区中的今天。
 * @returns 闭区间首尾日期；不校验未来和顺序。
 */
function resolveLocalDateRange(
  input: OperationsDashboardQueryInput,
  today: string
): { from: string; to: string } {
  if (input.range.kind === "custom") {
    return { from: input.range.from, to: input.range.to };
  }
  if (input.range.kind === "this_week") {
    return { from: getMonday(today), to: today };
  }
  if (input.range.kind === "this_month") {
    return { from: getMonthStart(today), to: today };
  }
  if (input.range.kind === "this_year") {
    return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
  return {
    from: addOperationsCalendarDays(
      today,
      -(OPERATIONS_DASHBOARD_DEFAULT_DAYS - 1)
    ),
    to: today,
  };
}

/**
 * 计算某粒度逻辑桶的首日。
 *
 * @param value 查询范围中的日期。
 * @param granularity 日、周或月。
 * @returns 日粒度原日、周粒度周一或月粒度一号。
 */
function getLogicalBucketStart(
  value: string,
  granularity: OperationsGranularity
): string {
  if (granularity === "week") return getMonday(value);
  if (granularity === "month") return getMonthStart(value);
  return value;
}

/**
 * 计算某逻辑桶之后的下一个桶首日。
 *
 * @param logicalStart 当前逻辑桶首日。
 * @param granularity 日、周或月。
 * @returns 下一个逻辑桶首日。
 */
function getNextLogicalBucketStart(
  logicalStart: string,
  granularity: OperationsGranularity
): string {
  if (granularity === "week") {
    return addOperationsCalendarDays(logicalStart, 7);
  }
  if (granularity === "month") return getNextMonthStart(logicalStart);
  return addOperationsCalendarDays(logicalStart, 1);
}

/**
 * 为当前范围生成不遗漏的日、周或月桶。
 *
 * 周桶固定周一开周；首尾桶按查询范围截断。epoch 前桶没有 dataFrom，跨 epoch 桶
 * 从 epoch 零点开始取数，从而不会把上线前缺失事实伪装为零。
 *
 * @param range 当前闭区间、时区、粒度、asOf 和 epoch。
 * @returns 按时间升序的完整桶数组；今天末桶截止同一 asOf。
 */
function buildBuckets(range: {
  from: string;
  to: string;
  today: string;
  timeZone: string;
  asOf: Date;
  epochDate: string;
  granularity: OperationsGranularity;
}): OperationsRangeBucket[] {
  const buckets: OperationsRangeBucket[] = [];
  let logicalStart = getLogicalBucketStart(range.from, range.granularity);
  while (logicalStart <= range.to) {
    const nextLogicalStart = getNextLogicalBucketStart(
      logicalStart,
      range.granularity
    );
    const logicalTo = addOperationsCalendarDays(nextLogicalStart, -1);
    const from = logicalStart < range.from ? range.from : logicalStart;
    const to = logicalTo > range.to ? range.to : logicalTo;
    const availability = resolveAvailability(from, to, range.epochDate);
    const end =
      to === range.today
        ? new Date(range.asOf)
        : requireDateStart(addOperationsCalendarDays(to, 1), range.timeZone);
    buckets.push({
      key: `${range.granularity}:${logicalStart}`,
      granularity: range.granularity,
      from,
      to,
      start: requireDateStart(from, range.timeZone),
      end,
      availability,
      dataFrom: resolveDataStart(from, to, range.epochDate, range.timeZone),
    });
    logicalStart = nextLogicalStart;
  }
  return buckets;
}

/**
 * 将总览输入解析为唯一的应用时区闭区间、UTC 半开边界和上一等长周期。
 *
 * @param input 不可信外部输入，函数内部执行 strict schema。
 * @param options 服务器捕获的时区、asOf 与不可变 epoch 日期。
 * @returns 当前范围、相邻上一周期和完整粒度桶。
 * @throws RangeError 当输入、时区、asOf、epoch、顺序或未来边界非法。
 */
export function resolveOperationsDashboardRange(
  input: unknown,
  options: ResolveOperationsDashboardRangeOptions
): ResolvedOperationsDashboardRange {
  const parsedInput = operationsDashboardQueryInputSchema.safeParse(input);
  if (!parsedInput.success) throw new RangeError("运营总览日期范围无效");
  if (Number.isNaN(options.asOf.getTime()))
    throw new RangeError("查询时间无效");
  const timeZone = options.timeZone.trim();
  if (!isValidTimeZone(timeZone)) throw new RangeError("应用时区无效");
  const parsedEpoch = operationsAppDateSchema.safeParse(options.epochDate);
  if (!parsedEpoch.success) throw new RangeError("运营统计起始日无效");

  const today = formatDateInputInTimeZone(options.asOf, timeZone);
  if (parsedEpoch.data > today) {
    throw new RangeError("运营统计起始日不能处于未来");
  }
  const { from, to } = resolveLocalDateRange(parsedInput.data, today);
  const dayCount = countInclusiveDays(from, to);
  if (dayCount <= 0) throw new RangeError("结束日期不能早于开始日期");
  if (to > today) throw new RangeError("结束日期不能处于未来");

  const start = requireDateStart(from, timeZone);
  const end =
    to === today
      ? new Date(options.asOf)
      : requireDateStart(addOperationsCalendarDays(to, 1), timeZone);
  const previousTo = addOperationsCalendarDays(from, -1);
  const previousFrom = addOperationsCalendarDays(previousTo, -(dayCount - 1));
  const previous = {
    from: previousFrom,
    to: previousTo,
    start: requireDateStart(previousFrom, timeZone),
    end: start,
    dayCount,
    availability: resolveAvailability(
      previousFrom,
      previousTo,
      parsedEpoch.data
    ),
    dataStart: resolveDataStart(
      previousFrom,
      previousTo,
      parsedEpoch.data,
      timeZone
    ),
  } satisfies OperationsComparisonRange;

  return {
    timeZone,
    asOf: new Date(options.asOf),
    today,
    epochDate: parsedEpoch.data,
    granularity: parsedInput.data.granularity,
    from,
    to,
    start,
    end,
    dayCount,
    availability: resolveAvailability(from, to, parsedEpoch.data),
    dataStart: resolveDataStart(from, to, parsedEpoch.data, timeZone),
    previous,
    buckets: buildBuckets({
      from,
      to,
      today,
      timeZone,
      asOf: options.asOf,
      epochDate: parsedEpoch.data,
      granularity: parsedInput.data.granularity,
    }),
  };
}

/**
 * 计算注册 Cohort 的精确 D1、D7 和 D30 成熟自然日。
 *
 * @param cohortDate 已验证的注册应用日期。
 * @returns 三个自然日目标；不受趋势粒度、DST 或范围结束日影响。
 * @throws RangeError 当注册日期非法。
 */
export function getCohortMaturityDates(cohortDate: string): {
  d1: string;
  d7: string;
  d30: string;
} {
  if (!operationsAppDateSchema.safeParse(cohortDate).success) {
    throw new RangeError("Cohort 注册日期无效");
  }
  return {
    d1: addOperationsCalendarDays(cohortDate, 1),
    d7: addOperationsCalendarDays(cohortDate, 7),
    d30: addOperationsCalendarDays(cohortDate, 30),
  };
}
