/**
 * 运营总览数字、日期、状态和比较值格式化纯函数。
 *
 * 使用方：指标卡、图表、Cohort、商业化、健康和导出记录。函数只格式化已校验
 * 快照，不改变单位、比较口径或特殊状态。
 */

import type { CountComparison } from "@repo/shared/operations-dashboard/comparison";

import { formatPaymentAmount } from "@/features/payment/payment-display-format";

export type OperationsDisplayStatus =
  | "value"
  | "pre_epoch"
  | "not_comparable"
  | "immature"
  | "current"
  | "no_data";

/** 以当前语言格式化安全数字，并保留最多两位小数。 */
export function formatOperationsNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
  }).format(value);
}

/** 以百分比格式化 0 到 1 的比率。 */
export function formatOperationsRate(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

/** 按币种小数位把最小单位金额转换为主单位并本地化展示。 */
export function formatOperationsMoney(
  amountMinor: number,
  currency: string,
  locale: string
): string {
  return formatPaymentAmount(amountMinor, currency, locale);
}

/** 把 ISO/Date 快照时间格式化到服务端声明的应用时区。 */
export function formatOperationsDateTime(
  value: Date | string,
  locale: string,
  timeZone: string
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone,
  }).format(new Date(value));
}

/** 把 YYYY-MM-DD 显示为紧凑本地日期，不参与统计边界计算。 */
export function formatOperationsDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

/** 把图表横轴日期压缩为月日或年份月份。 */
export function formatOperationsDateTick(value: string): string {
  return value.length >= 10 ? value.slice(5) : value;
}

/** 数量比较使用百分比；上线前或上期为零时保持不可比较。 */
export function formatCountComparison(
  comparison: CountComparison,
  locale: string,
  notComparableLabel: string
): string {
  if (comparison.status !== "value") return notComparableLabel;
  const sign = comparison.changePercent > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(comparison.changePercent)}%`;
}

/** 比率比较使用百分点，避免把比率变化误写成百分比变化。 */
export function formatPercentagePointChange(
  change: number,
  locale: string
): string {
  const sign = change > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(change)} pp`;
}
