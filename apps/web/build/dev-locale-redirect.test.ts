/**
 * 开发服务器语言前缀跳转测试。
 *
 * 使用方是 Vitest；规则需与 Go backend 的 spa.go 保持一致。
 */
import { describe, expect, it } from "vitest";

import { devPageRedirect, negotiateLocale } from "./dev-locale-redirect";

const page = { method: "GET", accept: "text/html,application/xhtml+xml" };

describe("dev locale redirect", () => {
  it("NEXT_LOCALE cookie 优先于 Accept-Language", () => {
    expect(negotiateLocale("a=1; NEXT_LOCALE=zh", "en-US,en;q=0.9")).toBe("zh");
    expect(negotiateLocale("NEXT_LOCALE=fr", "zh-CN,zh;q=0.9")).toBe("zh");
  });

  it("按权重挑选支持的语言，缺省为英文", () => {
    expect(negotiateLocale(undefined, "fr;q=1, en;q=0.5, zh-CN;q=0.8")).toBe(
      "zh"
    );
    expect(negotiateLocale(undefined, "zh;q=0, fr")).toBe("en");
    expect(negotiateLocale(undefined, undefined)).toBe("en");
  });

  it("无前缀页面跳到协商语言并保留查询串", () => {
    expect(
      devPageRedirect({ ...page, url: "/", acceptLanguage: "zh-CN" })
    ).toBe("/zh");
    expect(devPageRedirect({ ...page, url: "/forgot-password?x=1" })).toBe(
      "/en/forgot-password?x=1"
    );
  });

  it("已带语言前缀、非页面导航、资源和后端路径不跳转", () => {
    expect(devPageRedirect({ ...page, url: "/zh/legal/privacy" })).toBeNull();
    expect(
      devPageRedirect({ ...page, method: "POST", url: "/pricing" })
    ).toBeNull();
    expect(
      devPageRedirect({ method: "GET", accept: "*/*", url: "/src/main.tsx" })
    ).toBeNull();
    expect(devPageRedirect({ ...page, url: "/icon.png" })).toBeNull();
    expect(devPageRedirect({ ...page, url: "/@vite/client" })).toBeNull();
    expect(
      devPageRedirect({ ...page, url: "/api/auth/get-session" })
    ).toBeNull();
    expect(devPageRedirect({ ...page, url: "/r/abc" })).toBeNull();
  });

  it("无会话 cookie 的 Dashboard 请求跳到登录页", () => {
    expect(
      devPageRedirect({ ...page, url: "/zh/dashboard/history?page=2" })
    ).toBe(
      `/zh/sign-in?callbackUrl=${encodeURIComponent("/zh/dashboard/history?page=2")}`
    );
    expect(
      devPageRedirect({ ...page, url: "/dashboard", cookie: "NEXT_LOCALE=zh" })
    ).toBe(`/zh/sign-in?callbackUrl=${encodeURIComponent("/dashboard")}`);
    expect(
      devPageRedirect({
        ...page,
        url: "/zh/dashboard",
        cookie: "better-auth.session_token=t",
      })
    ).toBeNull();
    expect(
      devPageRedirect({
        ...page,
        url: "/dashboard",
        cookie: "better-auth.session_token=t",
      })
    ).toBe("/en/dashboard");
  });
});
