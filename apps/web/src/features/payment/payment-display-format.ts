/**
 * 支付金额的中立展示格式化工具。
 *
 * 使用方：支付后台、运营总览汇总与运营明细。只转换已校验金额的展示形式，
 * 不参与报价、计费、收入聚合或币种换算。
 */
import { amountMinorToMajor } from "@repo/shared/credits/top-up";

/**
 * 将最小货币单位格式化为带币种的本地化金额。
 *
 * @param amountMinor 最小货币单位整数。
 * @param currency 标准或未知的三字母币种代码。
 * @param locale Intl 支持的展示语言。
 * @returns 按币种小数位换算的本地化金额；Intl 拒绝输入时回退为代码加数字。
 */
export function formatPaymentAmount(
  amountMinor: number,
  currency: string,
  locale: string
): string {
  const amountMajor = amountMinorToMajor(amountMinor, currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 3,
    }).format(amountMajor);
  } catch {
    return `${currency} ${amountMajor.toLocaleString(locale)}`;
  }
}
