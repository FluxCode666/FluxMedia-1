/**
 * 中立支付金额展示格式测试。
 *
 * 使用方：支付后台与运营总览；锁定标准、零位、三位及未知三字母币种的共同展示。
 */
import { describe, expect, it } from "vitest";

import { formatPaymentAmount } from "./payment-display-format";

describe("formatPaymentAmount", () => {
  it.each([
    { amountMinor: 1_234, currency: "CNY", expected: "CN¥12.34" },
    { amountMinor: 1_234, currency: "JPY", expected: "¥1,234" },
    { amountMinor: 1_234, currency: "KWD", expected: "KWD\u00a01.234" },
    { amountMinor: 1_234, currency: "ZZZ", expected: "ZZZ\u00a012.34" },
  ])("按 $currency 的最小单位精度展示金额", ({
    amountMinor,
    currency,
    expected,
  }) => {
    expect(formatPaymentAmount(amountMinor, currency, "en-US")).toBe(expected);
  });
});
