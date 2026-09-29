/**
 * 构建期写入站点级 SEO 标签。
 *
 * 使用方：vite.config.ts。原 Next 在服务端渲染时输出根布局的元数据；SPA 首屏 HTML
 * 由 Go backend 托管，与地址无关的站点级标签（描述、关键词、分享卡片文案）在构建期
 * 写入 index.html，与语言和站点地址相关的标签（canonical、hreflang、og:url 等）由
 * Go backend 替换 `<!--route-meta-->` 占位。全部标签带 data-route-meta，客户端接管
 * 后由路由元数据统一替换。
 */
import type { Plugin } from "vite";

import { siteConfig } from "../../../packages/shared/src/config/site.ts";

export const ROUTE_META_PLACEHOLDER = "<!--route-meta-->";

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/** 渲染站点级标签；appName 为空时使用站点默认名称。 */
export function renderSiteMeta(appName: string | undefined): { title: string; tags: string } {
  const name = appName?.trim() || siteConfig.name;
  const tag = (attribute: "name" | "property", key: string, content: string) =>
    `<meta ${attribute}="${key}" content="${escapeAttribute(content)}" data-route-meta />`;
  const tags = [
    tag("name", "description", siteConfig.description),
    tag("name", "keywords", siteConfig.keywords.join(", ")),
    tag("property", "og:type", "website"),
    tag("property", "og:site_name", name),
    tag("property", "og:title", name),
    tag("property", "og:description", siteConfig.description),
    tag("name", "twitter:card", "summary_large_image"),
    tag("name", "twitter:title", name),
    tag("name", "twitter:description", siteConfig.description),
  ];
  return { title: name, tags: tags.join("\n    ") };
}

export function siteMeta(appName: string | undefined): Plugin {
  return {
    name: "fluxmedia-site-meta",
    transformIndexHtml(html) {
      const { title, tags } = renderSiteMeta(appName);
      return html
        .replace(/<title>[^<]*<\/title>/u, `<title>${escapeAttribute(title)}</title>`)
        .replace(ROUTE_META_PLACEHOLDER, `${tags}\n    ${ROUTE_META_PLACEHOLDER}`);
    },
  };
}
