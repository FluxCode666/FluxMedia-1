/**
 * 站点级公开配置。
 *
 * 使用方：页面元数据、公开导航、API 接入文档与浏览器端站点链接。
 * 关键依赖：仅读取可公开的 NEXT_PUBLIC_* 构建期变量。
 */
/** 默认公开站点地址；仅在部署地址未配置或配置为内部监听地址时使用。 */
export const DEFAULT_SITE_URL = "https://media.flux-code.cc";

const INTERNAL_SITE_HOSTNAMES = new Set([
  "0.0.0.0",
  "127.0.0.1",
  "localhost",
  "::",
  "::1",
  "[::]",
  "[::1]",
]);

export const siteConfig = {
  name: process.env.NEXT_PUBLIC_APP_NAME || "FluxMedia",

  description:
    "AI-powered chat-to-image generation platform. Transform your words into stunning visuals through natural conversation.",

  url: process.env.NEXT_PUBLIC_APP_URL || DEFAULT_SITE_URL,

  logo: "/api/site-logo",

  icon: "/assets/icon.png",

  ogImage: "/og-image.png",

  author: {
    name: "FluxMedia Team",
    url: "https://media.flux-code.cc",
    email: "support@media.flux-code.cc",
  },

  links: {
    twitter: "",
    github: "",
    discord: "",
  },

  keywords: [
    "AI Image Generation",
    "Chat to Image",
    "Text to Image",
    "AI Art",
    "FluxMedia",
    "Image Generation API",
    "Creative AI",
  ],
} as const;

export type SiteConfig = typeof siteConfig;

export type PublicAppUrlOptions = {
  /** 非生产环境是否允许 localhost 等本地地址，便于本地开发。 */
  allowInternal?: boolean;
};

/**
 * 解析一个可供浏览器访问的站点地址。
 *
 * @param value - 待解析的 URL 候选值。
 * @param options - 是否允许本地开发地址。
 * @returns 规范化后的 origin；非法或内部监听地址返回 null。
 */
export function normalizePublicAppUrl(
  value: unknown,
  options: PublicAppUrlOptions = {}
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      !options.allowInternal &&
      (INTERNAL_SITE_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost"))
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * 从候选配置中选择公开站点地址。
 *
 * @param candidates - 按优先级排列的 URL 候选值。
 * @param options - 是否允许本地开发地址。
 * @returns 第一个有效 origin；没有有效候选时回退默认公开地址。
 */
export function resolvePublicAppUrl(
  candidates: readonly unknown[],
  options: PublicAppUrlOptions = {}
) {
  for (const candidate of candidates) {
    const normalized = normalizePublicAppUrl(candidate, options);
    if (normalized) return normalized;
  }
  return DEFAULT_SITE_URL;
}

/**
 * 返回不带尾部斜杠的站点 Base URL。
 *
 * @returns 可直接拼接绝对路径的公开站点地址。
 * @sideEffects 无；读取模块初始化时生成的公开配置。
 * @failure 不抛错，也不执行 URL 语法校验。
 */
export function getSiteBaseUrl(): string {
  return siteConfig.url.replace(/\/+$/, "");
}
