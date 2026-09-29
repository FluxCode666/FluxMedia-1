/**
 * 构建期 SEO 文件测试。
 *
 * 使用方是 Vitest；验证 sitemap 发布模型广场与内容页，robots 屏蔽私有路径。
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSitemapEntries,
  readSeoContent,
  renderRobotsTxt,
  renderSitemapXml,
  resolveSiteUrl,
} from "./seo-files";

const empty = { blog: [], legal: [], pseo: [] };

describe("sitemap", () => {
  it("为 en 与 zh 发布模型广场 URL", () => {
    const urls = buildSitemapEntries("https://example.com", empty).map((entry) => entry.url);

    expect(urls).toContain("https://example.com/en/models");
    expect(urls).toContain("https://example.com/zh/models");
    expect(urls.filter((url) => url.endsWith("/models"))).toHaveLength(2);
  });

  it("包含仓库中的博客、法律文档与 pSEO 页面", () => {
    const content = readSeoContent(resolve(__dirname, ".."));
    const urls = buildSitemapEntries("https://example.com", content).map((entry) => entry.url);

    expect(urls).toContain("https://example.com/en/blog/hello-world");
    expect(urls).toContain("https://example.com/zh/legal/privacy");
    expect(content.pseo.length).toBeGreaterThan(0);
  });

  it("输出转义后的 XML", () => {
    const xml = renderSitemapXml(
      buildSitemapEntries("https://example.com", { ...empty, blog: [{ locale: "en", slug: "a&b" }] })
    );

    expect(xml).toContain("<loc>https://example.com/en/blog/a&amp;b</loc>");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe("robots", () => {
  it("屏蔽私有路径并指向 sitemap", () => {
    const robots = renderRobotsTxt(resolveSiteUrl("https://example.com/"));

    expect(robots).toContain("Disallow: /dashboard/");
    expect(robots).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("未配置站点地址时使用默认公开地址", () => {
    expect(resolveSiteUrl(undefined)).toBe("https://media.flux-code.cc");
  });
});
