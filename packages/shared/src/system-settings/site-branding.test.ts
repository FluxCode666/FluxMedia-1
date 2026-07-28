/**
 * 站点品牌配置契约测试。
 *
 * 职责：锁定 Logo 地址允许范围、递归防护与损坏配置回退语义。
 * 使用方：Vitest；不访问数据库、网络或文件系统。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SITE_LOGO_URL,
  resolveSiteLogoUrl,
  siteLogoUrlSchema,
} from "./site-branding";

describe("siteLogoUrlSchema", () => {
  it.each([
    ["/assets/custom-logo.svg", "/assets/custom-logo.svg"],
    [" /assets/logo.png?v=2 ", "/assets/logo.png?v=2"],
    [
      "https://cdn.example.com/brand/logo.webp",
      "https://cdn.example.com/brand/logo.webp",
    ],
  ])("接受可公开渲染的 Logo 地址 %s", (input, expected) => {
    expect(siteLogoUrlSchema.parse(input)).toBe(expected);
  });

  it.each([
    "",
    "/",
    "//cdn.example.com/logo.png",
    "http://cdn.example.com/logo.png",
    "https://user:secret@cdn.example.com/logo.png",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg />",
    "/assets/../secret.png",
    "/assets/%2e%2e/secret.png",
    "/assets\\logo.png",
    "https://cdn.example.com/logo.png\nset-cookie:test",
    "/api/site-logo",
    "/api/site-logo/nested",
  ])("拒绝不安全或递归地址 %s", (value) => {
    expect(siteLogoUrlSchema.safeParse(value).success).toBe(false);
  });
});

describe("resolveSiteLogoUrl", () => {
  it("运行时配置缺失或损坏时回退内置矢量 Logo", () => {
    expect(resolveSiteLogoUrl(undefined)).toBe(DEFAULT_SITE_LOGO_URL);
    expect(resolveSiteLogoUrl("ftp://cdn.example.com/logo.png")).toBe(
      DEFAULT_SITE_LOGO_URL
    );
  });
});
