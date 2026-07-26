/**
 * 登录与注册安全回跳纯函数测试。
 *
 * 使用方是认证页查询参数收窄；测试锁定站内 dashboard 白名单、locale 归一化、模型预选
 * 查询保留，以及开放重定向、路径逃逸和控制字符拒绝规则。
 */
import { describe, expect, it } from "vitest";

import { resolveSafeAuthCallbackUrl } from "./safe-callback-url";

describe("resolveSafeAuthCallbackUrl", () => {
  it("为无 locale 的 dashboard 路径补当前 locale 并保留查询参数", () => {
    expect(
      resolveSafeAuthCallbackUrl(
        "/dashboard/generate?category=image&model=gpt-image-2",
        "zh"
      )
    ).toBe("/zh/dashboard/generate?category=image&model=gpt-image-2");
  });

  it("保留当前 locale 下的完整视频模型预选查询", () => {
    expect(
      resolveSafeAuthCallbackUrl(
        "/en/dashboard/generate?category=image&model=gpt-image-2",
        "en"
      )
    ).toBe("/en/dashboard/generate?category=image&model=gpt-image-2");
  });

  it.each([
    undefined,
    null,
    "",
    "dashboard/generate",
    "/pricing",
    "/dashboard-evil",
    "/zh/dashboard/generate",
    "https://evil.test/dashboard",
    "//evil.test/dashboard",
    "/\\evil.test/dashboard",
    "/dashboard/%5cevil",
    "/dashboard/../sign-in",
    "/dashboard/%2e%2e/sign-in",
    "/dashboard/generate#outside",
    "/dashboard/generate?model=ok\nSet-Cookie:test",
    "/dashboard/generate?model=%0d%0aSet-Cookie:test",
  ])("对不安全 callback %j 回退当前 locale 首页", (callbackUrl) => {
    expect(resolveSafeAuthCallbackUrl(callbackUrl, "en")).toBe("/en/dashboard");
  });

  it("对未知当前 locale 使用默认 locale 且拒绝未知前缀", () => {
    expect(resolveSafeAuthCallbackUrl("/fr/dashboard", "fr")).toBe(
      "/en/dashboard"
    );
  });

  it("拒绝 Next.js 多值查询参数", () => {
    expect(
      resolveSafeAuthCallbackUrl(
        ["/dashboard", "https://evil.test/dashboard"],
        "zh"
      )
    ).toBe("/zh/dashboard");
  });
});
