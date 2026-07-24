/**
 * 站点导航配置契约测试。
 *
 * 使用方：Header、移动端 Sheet、Products 菜单、营销 Footer 与控制台侧边栏。
 * 关键依赖：`nav.ts` 的单一导航事实源；测试保持 DB-free。
 */
import { describe, expect, it } from "vitest";

import {
  dashboardNav,
  footerNav,
  getMarketingHeaderNavigation,
  mainNav,
  productsNav,
} from "./nav";

const FORBIDDEN_TITLES = new Set([
  "Pricing",
  "Credits System",
  "Social",
  "Twitter",
  "GitHub",
  "Discord",
]);

const FORBIDDEN_HREFS = new Set(["/#pricing", "/#features"]);

/**
 * 将所有营销导航项压平成统一数组，供死入口断言复用。
 *
 * @returns Header、Products 与 Footer 中可点击项的只读集合。
 */
function collectMarketingItems() {
  return [
    ...mainNav,
    ...productsNav.flatMap((group) => group.items),
    ...footerNav.product,
    ...footerNav.legal,
  ];
}

describe("营销导航契约", () => {
  it("首页导航包含完整区块入口、文档与博客", () => {
    const navigation = getMarketingHeaderNavigation("home");

    expect(navigation.items.map((item) => [item.title, item.href])).toEqual([
      ["Models", "/#models"],
      ["Quick Integration", "/#integration"],
      ["Work", "/#work"],
      ["Start Creating", "/#create"],
      ["Docs", "/api-docs"],
      ["Blog", "/blog"],
    ]);
    expect(navigation.productGroups).toEqual([]);
  });

  it("非首页营销导航使用相同目标并只保留有效产品入口", () => {
    const home = getMarketingHeaderNavigation("home");
    const marketing = getMarketingHeaderNavigation("marketing");

    expect(marketing.items).toBe(home.items);
    expect(marketing.productGroups).toBe(productsNav);
    expect(marketing.productGroups.flatMap((group) => group.items)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Chat to Image", href: "/dashboard" }),
        expect.objectContaining({ title: "Gallery", href: "/dashboard" }),
        expect.objectContaining({
          title: "Batch Generation",
          href: "/dashboard",
        }),
      ])
    );
  });

  it("所有首页锚点保持 locale-neutral，交由 i18n Link 只添加一次语言前缀", () => {
    const homepageAnchors = mainNav
      .map((item) => item.href)
      .filter((href) => href.startsWith("/#"));

    expect(homepageAnchors).toEqual([
      "/#models",
      "/#integration",
      "/#work",
      "/#create",
    ]);
    for (const href of homepageAnchors) {
      expect(href).not.toMatch(/^\/(?:en|zh)(?:\/|#)/);
    }
  });

  it("共享导航不再暴露定价、积分、社媒或旧首页锚点", () => {
    const items = collectMarketingItems();

    for (const item of items) {
      expect(FORBIDDEN_TITLES.has(item.title)).toBe(false);
      expect(FORBIDDEN_HREFS.has(item.href)).toBe(false);
      expect(item.href.trim()).not.toBe("");
    }
  });
});

describe("控制台导航契约", () => {
  it("提供独立简易生图入口，同时不重新暴露旧创作页入口", () => {
    const dashboardItems = dashboardNav.flatMap((group) => group.items);

    expect(dashboardItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Generate",
          href: "/dashboard/generate",
        }),
      ])
    );
    expect(dashboardItems).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: "/dashboard/create" }),
      ])
    );
  });
});
