/** 运营总览格式化纯函数回归测试：锁定不同币种最小单位到展示金额的换算。 */
import { describe, expect, it } from "vitest";

import { formatOperationsMoney } from "./operations-dashboard-format";

describe("formatOperationsMoney", () => {
  it.each([
    { amountMinor: 1234, currency: "JPY", amountMajor: 1234 },
    { amountMinor: 1234, currency: "CNY", amountMajor: 12.34 },
    { amountMinor: 1234, currency: "KWD", amountMajor: 1.234 },
  ])("按 $currency 的最小单位小数位格式化金额", ({
    amountMinor,
    currency,
    amountMajor,
  }) => {
    const expected = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amountMajor);

    expect(formatOperationsMoney(amountMinor, currency, "en-US")).toBe(
      expected
    );
  });
});
