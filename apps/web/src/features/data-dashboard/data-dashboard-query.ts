/**
 * 用户数据看板 URL、深链与快捷自然日范围纯函数。
 *
 * RSC 与客户端共用这里的 strict query 解释，防止未知身份参数、单边日期或不同默认
 * 范围进入页面状态。所有计算只处理 YYYY-MM-DD，不读取浏览器时区。
 */
import {
  DATA_DASHBOARD_DEFAULT_DAYS,
  type DataDashboardInput,
  dataDashboardInputSchema,
} from "@repo/shared/analytics/contracts";

export type DataDashboardAppliedRange = {
  startDate: string;
  endDate: string;
};

export type DataDashboardSearchParams = Record<
  string,
  string | string[] | undefined
>;

/** 将可信 Gregorian 日期移动指定自然日，不依赖运行时本地时区。 */
function shiftDashboardDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  date.setUTCDate(date.getUTCDate() + days);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(
    date.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 把页面 query 收窄为空输入或成对日期。
 *
 * @param params Next.js searchParams；数组、未知字段和非法 Gregorian 日期均不可信。
 * @returns 可交给 UOL 的 strict 输入，以及是否需要显示一次深链回退提示。
 */
export function parseDataDashboardSearchParams(
  params: DataDashboardSearchParams
): { input: DataDashboardInput; invalidDeepLink: boolean } {
  const keys = Object.keys(params);
  if (keys.length === 0) return { input: {}, invalidDeepLink: false };
  if (
    keys.some((key) => key !== "startDate" && key !== "endDate") ||
    typeof params.startDate !== "string" ||
    typeof params.endDate !== "string"
  ) {
    return { input: {}, invalidDeepLink: true };
  }
  const parsed = dataDashboardInputSchema.safeParse({
    startDate: params.startDate,
    endDate: params.endDate,
  });
  return parsed.success
    ? { input: parsed.data, invalidDeepLink: false }
    : { input: {}, invalidDeepLink: true };
}

/** 构造默认 canonical 路径或同时包含两个日期的自定义路径。 */
export function buildDataDashboardHref(input: DataDashboardInput): string {
  if (!("startDate" in input)) return "/dashboard/analytics";
  const search = new URLSearchParams({
    startDate: input.startDate,
    endDate: input.endDate,
  });
  return `/dashboard/analytics?${search.toString()}`;
}

/**
 * 以账号时区 today 构造首尾包含的快捷自然日范围。
 *
 * @param today UOL 快照返回的账号时区当前日期。
 * @param days 需要包含的正整数自然日数。
 * @returns 结束于 today 的成对日期。
 */
export function buildDataDashboardPresetRange(
  today: string,
  days: number
): DataDashboardAppliedRange {
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new RangeError("快捷日期范围天数必须是正整数");
  }
  return {
    startDate: shiftDashboardDate(today, -(days - 1)),
    endDate: today,
  };
}

/** 判断已应用范围是否等于该快照 today 对应的动态默认七天。 */
export function isDefaultDataDashboardRange(
  range: DataDashboardAppliedRange,
  today: string
): boolean {
  const defaultRange = buildDataDashboardPresetRange(
    today,
    DATA_DASHBOARD_DEFAULT_DAYS
  );
  return (
    range.startDate === defaultRange.startDate &&
    range.endDate === defaultRange.endDate
  );
}
