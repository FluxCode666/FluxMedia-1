/**
 * 构建期站点级 SEO 标签测试。
 *
 * 使用方是 Vitest；验证标签由客户端元数据接管、应用名可覆盖且内容被转义。
 */
import { describe, expect, it } from "vitest";

import { ROUTE_META_PLACEHOLDER, renderSiteMeta, siteMeta } from "./site-meta";

describe("site meta", () => {
  it("全部标签带 data-route-meta，供客户端替换", () => {
    const { tags } = renderSiteMeta(undefined);
    const lines = tags.split("\n").map((line) => line.trim());
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(line).toContain("data-route-meta");
  });

  it("应用名覆盖标题与分享卡片并转义", () => {
    const { title, tags } = renderSiteMeta('A&B "Studio"');
    expect(title).toBe('A&B "Studio"');
    expect(tags).toContain('<meta property="og:site_name" content="A&amp;B &quot;Studio&quot;" data-route-meta />');
  });

  it("保留占位供 Go backend 写入语言相关标签", () => {
    const plugin = siteMeta("Flux");
    const transform = plugin.transformIndexHtml as (html: string) => string;
    const html = transform(`<title>FluxMedia</title>\n    ${ROUTE_META_PLACEHOLDER}`);
    expect(html).toContain("<title>Flux</title>");
    expect(html).toContain('name="description"');
    expect(html.trimEnd().endsWith(ROUTE_META_PLACEHOLDER)).toBe(true);
  });
});
