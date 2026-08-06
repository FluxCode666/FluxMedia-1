/** 钱包支付回跳 helper 测试：锁定同源钱包目标并拒绝任意客户端 URL。 */
import { describe, expect, it } from "vitest";

import { createWalletPaymentResultUrl } from "./redirects";

describe("wallet payment redirects", () => {
  it("只允许白名单支付状态进入钱包 URL", () => {
    expect(
      createWalletPaymentResultUrl("processing", "https://flux.example")
    ).toBe("https://flux.example/dashboard/wallet?pay=processing");
    expect(
      createWalletPaymentResultUrl(
        "https://evil.example",
        "https://flux.example"
      )
    ).toBe("https://flux.example/dashboard/wallet");
  });
});
