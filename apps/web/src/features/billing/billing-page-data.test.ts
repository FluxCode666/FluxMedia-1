/** 旧 billing 重定向矩阵测试：锁定页面职责拆分与支付上下文白名单。 */
import { describe, expect, it } from "vitest";

import { resolveLegacyBillingRedirect } from "./billing-page-data";

describe("resolveLegacyBillingRedirect", () => {
  it.each([
    [{}, "/dashboard/wallet"],
    [{ tab: "billing" }, "/dashboard/wallet"],
    [{ tab: "unknown" }, "/dashboard/wallet"],
    [{ tab: "usage" }, "/dashboard/history"],
  ])("把旧页面参数 %o 迁移到 %s", (searchParams, expected) => {
    expect(resolveLegacyBillingRedirect(searchParams)).toBe(expected);
  });

  it("支付上下文优先进入钱包并只透传白名单", () => {
    expect(
      resolveLegacyBillingRedirect({
        tab: "usage",
        pay: "processing",
        purchase: "subscription",
        ignored: "secret",
      })
    ).toBe("/dashboard/wallet?pay=processing");
  });

  it("兼容旧 cancel 并丢弃数组、HTML 与跨站载荷", () => {
    expect(resolveLegacyBillingRedirect({ pay: "cancel" })).toBe(
      "/dashboard/wallet?pay=canceled"
    );
    expect(
      resolveLegacyBillingRedirect({
        pay: "<script>alert(1)</script>",
        purchase: ["top-up", "subscription"],
        success: "https://evil.example",
      })
    ).toBe("/dashboard/wallet");
  });

  it("只接受明确的旧 success=true", () => {
    expect(resolveLegacyBillingRedirect({ success: "true" })).toBe(
      "/dashboard/wallet?success=true"
    );
    expect(resolveLegacyBillingRedirect({ success: "false" })).toBe(
      "/dashboard/wallet"
    );
  });
});
