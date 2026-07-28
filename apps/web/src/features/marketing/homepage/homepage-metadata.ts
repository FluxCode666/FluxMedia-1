/**
 * 官网首页 Metadata 的双语事实源。
 *
 * 使用方：首页路由与纯函数测试；只描述作品、当前运行时图像与视频模型和既有 API
 * 集成，不读取或写入运行时模型 ID，也不承载订阅、积分或定价信息。
 */
import { siteConfig } from "@repo/shared/config";
import type { Metadata } from "next";

/** 首页 SEO 支持的语言。 */
export type HomepageMetadataLocale = "en" | "zh";

const HOMEPAGE_METADATA_COPY = {
  zh: {
    title: "FluxMedia - AI 作品、运行时模型与 API 集成",
    description:
      "用自然语言创作图像与视频作品，浏览当前运行时生成模型，并通过现有 API 集成将 FluxMedia 接入服务端工作流。",
    keywords: [
      "AI 作品生成",
      "运行时模型",
      "图像生成 API",
      "视频生成模型",
      "文生图模型",
      "AI 图像模型",
      "自然语言创作",
      "FluxMedia",
    ],
  },
  en: {
    title: "FluxMedia - AI Work, Runtime Models & API Integration",
    description:
      "Create image and video work with natural language, explore current runtime generation models, and connect FluxMedia to server-side workflows through the existing API integration.",
    keywords: [
      "AI artwork generation",
      "runtime AI models",
      "image generation API",
      "video generation models",
      "text to image models",
      "AI image models",
      "natural language creation",
      "FluxMedia",
    ],
  },
} as const satisfies Record<
  HomepageMetadataLocale,
  { title: string; description: string; keywords: readonly string[] }
>;

/**
 * 将路由 locale 收窄到首页 SEO 支持的语言。
 *
 * @param locale - 路由传入的语言标识。
 * @returns 中文标识原样保留，其余值安全回退为英文。
 */
export function normalizeHomepageMetadataLocale(
  locale: string
): HomepageMetadataLocale {
  return locale === "zh" ? "zh" : "en";
}

/**
 * 构建本地化首页 Metadata。
 *
 * @param locale - 已收窄的首页语言。
 * @returns 首页搜索摘要、关键词和分享卡；无副作用且不依赖具体运行时模型 ID。
 */
export function buildHomepageMetadata(
  locale: HomepageMetadataLocale
): Metadata {
  const copy = HOMEPAGE_METADATA_COPY[locale];

  return {
    title: copy.title,
    description: copy.description,
    keywords: [...copy.keywords],
    openGraph: {
      title: copy.title,
      description: copy.description,
      type: "website",
      url: `${siteConfig.url}/${locale}`,
      siteName: siteConfig.name,
      images: [
        {
          url: `${siteConfig.url}${siteConfig.ogImage}`,
          width: 1200,
          height: 630,
          alt: siteConfig.name,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.description,
      images: [`${siteConfig.url}${siteConfig.ogImage}`],
    },
  };
}
