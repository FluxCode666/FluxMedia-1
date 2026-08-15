/**
 * 管理端支付展示格式化适配器。
 *
 * 使用方：支付概览图表与订单列表。金额复用中立支付展示实现，本文件仅保留
 * 管理端图表专用的紧凑数字格式。
 */
export { formatPaymentAmount } from "../payment-display-format";

/** 将图表轴数值压缩为本地化紧凑数字，不附加任一币种以免误导。 */
export function formatCompactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
