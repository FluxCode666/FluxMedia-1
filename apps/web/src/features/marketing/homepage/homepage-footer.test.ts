/**
 * 首页合层 Footer 的模型广场入口测试。
 *
 * 使用方是 Vitest；以静态标记验证首页页尾在现有站点列中加入 locale-neutral `/models`。
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => createElement("img", props),
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

import { HomepageFooter, type HomepageFooterCopy } from "./homepage-footer";

const COPY: HomepageFooterCopy = {
  eyebrow: "Begin",
  title: "Create next",
  description: "Description",
  cta: "Create",
  brandDescription: "Brand",
  siteLabel: "Site",
  legalLabel: "Legal",
  models: "Models",
  docs: "Docs",
  contact: "Contact",
  terms: "Terms",
  privacy: "Privacy",
  cookie: "Cookies",
  copyright: "Copyright",
};

describe("HomepageFooter", () => {
  it("在站点列提供模型广场和文档入口", () => {
    const html = renderToStaticMarkup(
      createElement(HomepageFooter, {
        copy: COPY,
        ctaHref: "/sign-up",
      })
    );

    expect(html).toContain('href="/models"');
    expect(html).toContain('href="/api-docs"');
    expect(html).toContain(">Models</a>");
  });
});
