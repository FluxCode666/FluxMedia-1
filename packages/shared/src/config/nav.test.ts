/**
 * 站点导航配置契约测试。
 *
 * 使用方：Header、移动端 Sheet、营销 Footer 与控制台侧边栏。
 * 关键依赖：`nav.ts` 的单一导航事实源；测试保持 DB-free。
 */
import { describe, expect, it } from "vitest";

import { dashboardNav, footerNav, mainNav } from "./nav";

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
 * @returns Header 与 Footer 中可点击项的只读集合。
 */
function collectMarketingItems() {
  return [...mainNav, ...footerNav.product, ...footerNav.legal];
}

describe("营销导航契约", () => {
  it("Header 仅保留模型广场与 API 文档入口", () => {
    expect(mainNav.map((item) => [item.title, item.href])).toEqual([
      ["Models", "/models"],
      ["Docs", "/api-docs"],
    ]);
  });

  it("Header 不再暴露旧版产品菜单、首页锚点或博客入口", () => {
    expect(mainNav.map((item) => item.title)).not.toEqual(
      expect.arrayContaining([
        "Products",
        "Quick Integration",
        "Work",
        "Start Creating",
        "Blog",
      ])
    );
    expect(mainNav.some((item) => item.href.startsWith("/#"))).toBe(false);
  });

  it("共享导航不再暴露定价、积分、社媒或旧首页锚点", () => {
    const items = collectMarketingItems();

    for (const item of items) {
      expect(FORBIDDEN_TITLES.has(item.title)).toBe(false);
      expect(FORBIDDEN_HREFS.has(item.href)).toBe(false);
      expect(item.href.trim()).not.toBe("");
    }
  });

  it("Header 与 Footer 共同暴露 locale-neutral 模型广场入口", () => {
    expect(mainNav).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Models", href: "/models" }),
      ])
    );
    expect(footerNav.product).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Models", href: "/models" }),
      ])
    );
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

  it("生图入口紧跟图库，方便从作品浏览继续创建", () => {
    const dashboardItems = dashboardNav.flatMap((group) => group.items);
    const galleryIndex = dashboardItems.findIndex(
      (item) => item.href === "/dashboard/gallery"
    );
    const generateIndex = dashboardItems.findIndex(
      (item) => item.href === "/dashboard/generate"
    );

    expect(galleryIndex).toBeGreaterThanOrEqual(0);
    expect(generateIndex).toBe(galleryIndex + 1);
  });

  it("模型广场入口紧跟接入文档", () => {
    const dashboardItems = dashboardNav.flatMap((group) => group.items);
    const apiDocsIndex = dashboardItems.findIndex(
      (item) => item.href === "/dashboard/api-docs"
    );
    const modelsIndex = dashboardItems.findIndex(
      (item) => item.href === "/models"
    );

    expect(apiDocsIndex).toBeGreaterThanOrEqual(0);
    expect(modelsIndex).toBe(apiDocsIndex + 1);
  });
});
