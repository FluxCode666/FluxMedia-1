/**
 * 管理端支付展示格式化工具。
 *
 * 使用方：支付概览图表与订单列表。只做展示转换，不参与计费或收入聚合。
 */
import { amountMinorToMajor } from "@repo/shared/credits/top-up";

/** 将最小货币单位格式化为带币种的本地化金额。 */
export function formatPaymentAmount(
  amountMinor: number,
  currency: string,
  locale: string
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 3,
    }).format(amountMinorToMajor(amountMinor, currency));
  } catch {
    return `${currency} ${amountMinorToMajor(
      amountMinor,
      currency
    ).toLocaleString(locale)}`;
  }
}

/** 将图表轴数值压缩为本地化紧凑数字，不附加任一币种以免误导。 */
export function formatCompactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
