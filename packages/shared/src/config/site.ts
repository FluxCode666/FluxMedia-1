/**
 * 站点级公开配置。
 *
 * 使用方：页面元数据、公开导航、API 接入文档与浏览器端站点链接。
 * 关键依赖：仅读取可公开的 NEXT_PUBLIC_* 构建期变量。
 */
export const siteConfig = {
  name: process.env.NEXT_PUBLIC_APP_NAME || "FluxMedia",

  description:
    "AI-powered chat-to-image generation platform. Transform your words into stunning visuals through natural conversation.",

  url: process.env.NEXT_PUBLIC_APP_URL || "https://media.flux-code.cc",

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
