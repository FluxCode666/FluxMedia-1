/**
 * 构建期生成 sitemap.xml 与 robots.txt。
 *
 * 使用方：vite.config.ts 的构建插件。原 Next 的 sitemap/robots 路由同样在构建期
 * 由内容目录与 pSEO 数据生成；SPA 构建把它们作为静态文件写入 dist，随前端一起
 * 嵌入 Go 二进制并由根路径托管。
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const LOCALES = ["en", "zh"] as const;
const STATIC_PATHS = ["", "/models", "/blog", "/pseo"] as const;
const SOLUTION_TYPES = ["text", "pdf", "url", "video", "word", "markdown"] as const;
const ROBOTS_DISALLOW = [
  "/api/",
  "/dashboard/",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
] as const;

export const DEFAULT_SITE_URL = "https://media.flux-code.cc";

type ChangeFrequency = "weekly" | "monthly" | "yearly";

export type SitemapEntry = {
  url: string;
  lastModified: Date;
  changeFrequency: ChangeFrequency;
  priority: number;
};

export type LocalizedSlug = { locale: string; slug: string };

export type SeoContent = {
  blog: readonly LocalizedSlug[];
  legal: readonly LocalizedSlug[];
  pseo: readonly LocalizedSlug[];
};

/** 构建期公开站点地址；未配置时回退默认公开地址。 */
export function resolveSiteUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_SITE_URL).replace(/\/+$/u, "");
}

/** 生成全部公开页面的 sitemap 条目。 */
export function buildSitemapEntries(baseUrl: string, content: SeoContent, now = new Date()): SitemapEntry[] {
  const entry = (path: string, changeFrequency: ChangeFrequency, priority: number): SitemapEntry => ({
    url: `${baseUrl}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  });
  return [
    ...LOCALES.flatMap((locale) =>
      STATIC_PATHS.map((path) => entry(`/${locale}${path}`, "weekly", path === "" ? 1 : 0.8))
    ),
    ...LOCALES.flatMap((locale) =>
      SOLUTION_TYPES.map((type) => entry(`/${locale}/solutions/${type}`, "monthly", 0.9))
    ),
    ...content.blog.map(({ locale, slug }) => entry(`/${locale}/blog/${slug}`, "monthly", 0.7)),
    ...content.legal.map(({ locale, slug }) => entry(`/${locale}/legal/${slug}`, "yearly", 0.3)),
    ...content.pseo.map(({ locale, slug }) => entry(`/${locale}/pseo/${slug}`, "weekly", 0.6)),
  ];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export function renderSitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map(
    (item) =>
      `<url>\n<loc>${escapeXml(item.url)}</loc>\n<lastmod>${item.lastModified.toISOString()}</lastmod>\n` +
      `<changefreq>${item.changeFrequency}</changefreq>\n<priority>${item.priority}</priority>\n</url>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function renderRobotsTxt(baseUrl: string): string {
  return [
    "User-Agent: *",
    "Allow: /",
    ...ROBOTS_DISALLOW.map((path) => `Disallow: ${path}`),
    "",
    `Sitemap: ${baseUrl}/sitemap.xml`,
    "",
  ].join("\n");
}

function listMdxSlugs(directory: string): LocalizedSlug[] {
  return LOCALES.flatMap((locale) => {
    let files: string[];
    try {
      files = readdirSync(resolve(directory, locale));
    } catch {
      return [];
    }
    return files
      .filter((file) => file.endsWith(".mdx"))
      .sort()
      .map((file) => ({ locale, slug: file.slice(0, -".mdx".length) }));
  });
}

/** 从 Web 工程目录读取博客、法律文档与 pSEO 页面列表。 */
export function readSeoContent(webRoot: string): SeoContent {
  const pages = JSON.parse(
    readFileSync(resolve(webRoot, "src/features/pseo/data/pseo-pages.json"), "utf8")
  ) as Array<{ slug: string; locales: Record<string, unknown> }>;
  return {
    blog: listMdxSlugs(resolve(webRoot, "src/content/blog")),
    legal: listMdxSlugs(resolve(webRoot, "src/content/legal")),
    pseo: pages.flatMap((page) => Object.keys(page.locales).map((locale) => ({ locale, slug: page.slug }))),
  };
}

/** Vite 构建插件：把 sitemap.xml 与 robots.txt 写入产物根目录。 */
export function seoFiles({ webRoot, siteUrl }: { webRoot: string; siteUrl: string | undefined }): Plugin {
  return {
    name: "fluxmedia-seo-files",
    apply: "build",
    generateBundle() {
      const baseUrl = resolveSiteUrl(siteUrl);
      const entries = buildSitemapEntries(baseUrl, readSeoContent(webRoot));
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: renderSitemapXml(entries) });
      this.emitFile({ type: "asset", fileName: "robots.txt", source: renderRobotsTxt(baseUrl) });
    },
  };
}
