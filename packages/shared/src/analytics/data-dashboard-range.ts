/**
 * 用户数据看板账号时区自然日范围解析器。
 *
 * 聚合服务显式传入账号有效 IANA 时区与同一数据库快照捕获的 asOf；本模块只处理
 * 最多 30 个 Gregorian 自然日并输出 UTC 半开边界，不读取浏览器、系统时区或数据库。
 */
import {
  formatDateInputInTimeZone,
  isValidTimeZone,
  parseDateInputInTimeZone,
} from "../time-zone";
import {
  DATA_DASHBOARD_DEFAULT_DAYS,
  DATA_DASHBOARD_MAX_DAYS,
  type DataDashboardInput,
  dataDashboardInputSchema,
} from "./data-dashboard-contracts";

export type ResolvedDataDashboardBucket = {
  date: string;
  start: Date;
  end: Date;
};

export type ResolvedDataDashboardRange = {
  timeZone: string;
  asOf: Date;
  today: string;
  startDate: string;
  endDate: string;
  start: Date;
  end: Date;
  bucketCount: number;
  buckets: ResolvedDataDashboardBucket[];
};

export type ResolveDataDashboardRangeOptions = {
  timeZone: string;
  asOf: Date;
};

/**
 * 将合法 Gregorian 日期移动指定自然日数。
 *
 * @param value 已通过输入 schema 的 YYYY-MM-DD 日期。
 * @param days 可正可负的整数自然日数。
 * @returns 移动后的固定格式日期；不受服务器时区或 DST 影响。
 */
function shiftCalendarDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  date.setUTCDate(date.getUTCDate() + days);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(
    date.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 计算首尾包含的 Gregorian 自然日数量。
 *
 * @param startDate 起始日期。
 * @param endDate 结束日期。
 * @returns 正向范围的 inclusive 天数；反向范围返回非正数。
 */
function countInclusiveDates(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

/**
 * 将本地日期解析为账号时区零点，并把理论上不可能的映射失败显式上抛。
 *
 * @param value 已验证的 Gregorian 日期。
 * @param timeZone 已验证的 IANA 时区。
 * @returns 对应的 UTC 瞬间。
 * @throws RangeError 当运行时无法映射该自然日边界。
 */
function requireLocalDateStart(value: string, timeZone: string): Date {
  const parsed = parseDateInputInTimeZone(value, { timeZone });
  if (!parsed) throw new RangeError("无法解析账号时区自然日边界");
  return parsed;
}

/**
 * 从 strict 输入选择默认七天或自定义日期范围。
 *
 * @param input 已通过 dataDashboardInputSchema 的输入。
 * @param today 账号时区中的查询日期。
 * @returns 规范化的首尾日期字符串。
 */
function resolveLocalDates(
  input: DataDashboardInput,
  today: string
): { startDate: string; endDate: string } {
  if ("startDate" in input) {
    return { startDate: input.startDate, endDate: input.endDate };
  }
  return {
    startDate: shiftCalendarDate(today, -(DATA_DASHBOARD_DEFAULT_DAYS - 1)),
    endDate: today,
  };
}

/**
 * 构造每个账号时区自然日的真实 UTC 边界。
 *
 * @param startDate 范围首日。
 * @param bucketCount 首尾包含的桶数。
 * @param today 账号时区中的当前日期。
 * @param timeZone 已验证的 IANA 时区。
 * @param asOf 同一数据库快照的查询时刻。
 * @returns 连续自然日桶；历史桶止于次日零点，今天桶止于 asOf。
 */
function buildResolvedBuckets(
  startDate: string,
  bucketCount: number,
  today: string,
  timeZone: string,
  asOf: Date
): ResolvedDataDashboardBucket[] {
  return Array.from({ length: bucketCount }, (_, index) => {
    const date = shiftCalendarDate(startDate, index);
    const start = requireLocalDateStart(date, timeZone);
    const naturalEnd = requireLocalDateStart(
      shiftCalendarDate(date, 1),
      timeZone
    );
    return {
      date,
      start,
      end: date === today ? asOf : naturalEnd,
    };
  });
}

/**
 * 将看板输入解析成最多 30 个账号时区自然日及唯一 UTC 半开范围。
 *
 * @param input 外部输入；函数内部再次执行 strict schema，拒绝身份和未知字段。
 * @param options 显式账号有效时区与同一数据库快照捕获的 asOf。
 * @returns 默认七天或自定义范围，以及每个自然日真实 UTC 边界。
 * @throws RangeError 当输入、时区、asOf、顺序、未来日期或 30 天上限非法。
 */
export function resolveDataDashboardRange(
  input: unknown,
  options: ResolveDataDashboardRangeOptions
): ResolvedDataDashboardRange {
  const parsedInput = dataDashboardInputSchema.safeParse(input);
  if (!parsedInput.success) throw new RangeError("数据看板日期范围无效");
  if (Number.isNaN(options.asOf.getTime())) {
    throw new RangeError("查询时间无效");
  }
  const timeZone = options.timeZone.trim();
  if (!isValidTimeZone(timeZone)) throw new RangeError("账号有效时区无效");

  const today = formatDateInputInTimeZone(options.asOf, timeZone);
  const { startDate, endDate } = resolveLocalDates(parsedInput.data, today);
  const bucketCount = countInclusiveDates(startDate, endDate);
  if (bucketCount <= 0) throw new RangeError("结束日期不能早于开始日期");
  if (bucketCount > DATA_DASHBOARD_MAX_DAYS) {
    throw new RangeError("数据看板日期范围不能超过 30 个自然日");
  }
  if (endDate > today) throw new RangeError("结束日期不能处于未来");

  const buckets = buildResolvedBuckets(
    startDate,
    bucketCount,
    today,
    timeZone,
    options.asOf
  );
  const firstBucket = buckets[0];
  const lastBucket = buckets.at(-1);
  if (!firstBucket || !lastBucket) {
    throw new RangeError("数据看板日期范围不能为空");
  }

  return {
    timeZone,
    asOf: options.asOf,
    today,
    startDate,
    endDate,
    start: firstBucket.start,
    end: lastBucket.end,
    bucketCount,
    buckets,
  };
}
