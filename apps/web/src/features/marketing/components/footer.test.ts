/**
 * 普通营销 Footer 的站点发现入口测试。
 *
 * 使用方是 Vitest；验证模型广场使用本地化站内 Link，mailto 继续使用外部协议链接。
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ getLocale: async () => "zh" }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { "data-i18n-link": "", href }, children),
}));

import { Footer, isExternalFooterHref } from "./footer";

describe("Footer", () => {
  it("显示模型广场站内入口和 mailto 外部入口", async () => {
    const html = renderToStaticMarkup(await Footer());

    expect(html).toContain('href="/models"');
    expect(html).toContain("模型广场");
    expect(html).toContain('data-i18n-link=""');
    expect(html).toContain('href="mailto:support@media.flux-code.cc"');
  });

  it("只把非根路径协议识别为外部链接", () => {
    expect(isExternalFooterHref("/models")).toBe(false);
    expect(isExternalFooterHref("/legal/terms")).toBe(false);
    expect(isExternalFooterHref("mailto:support@example.com")).toBe(true);
    expect(isExternalFooterHref("https://example.com")).toBe(true);
  });
});
