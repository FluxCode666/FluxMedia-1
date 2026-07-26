/**
 * 公开模型广场的双语 Metadata 事实源。
 *
 * 使用方是 `/[locale]/models` 路由与纯函数测试；输出本地化标题、说明、canonical 和
 * 双语 alternates，不读取运行时目录或固定具体模型名。
 */
import { siteConfig } from "@repo/shared/config";
import type { Metadata } from "next";

/** 模型广场 SEO 支持的路由语言。 */
export type ModelMarketplaceMetadataLocale = "en" | "zh";

const MODEL_MARKETPLACE_METADATA_COPY = {
  zh: {
    title: "模型广场 - FluxMedia",
    description:
      "浏览 FluxMedia 当前公开可用的图像与视频生成模型，比较最低积分价格、完整计费档位和支持参数。",
  },
  en: {
    title: "Model Marketplace - FluxMedia",
    description:
      "Explore the image and video generation models currently available on FluxMedia, with starting credit prices, complete pricing tiers, and supported parameters.",
  },
} as const satisfies Record<
  ModelMarketplaceMetadataLocale,
  { title: string; description: string }
>;

/**
 * 将未知 locale 收窄为模型广场支持的语言。
 *
 * @param locale - Next.js 动态路由语言。
 * @returns zh 原样保留，其余值安全回退 en。
 * @sideEffects 无。
 */
export function normalizeModelMarketplaceMetadataLocale(
  locale: string
): ModelMarketplaceMetadataLocale {
  return locale === "zh" ? "zh" : "en";
}

/**
 * 构建本地化模型广场 Metadata。
 *
 * @param locale - 已收窄的 en 或 zh。
 * @returns 页面摘要、canonical、双语 alternates 与分享卡。
 * @sideEffects 无。
 */
export function buildModelMarketplaceMetadata(
  locale: ModelMarketplaceMetadataLocale
): Metadata {
  const copy = MODEL_MARKETPLACE_METADATA_COPY[locale];
  const canonical = `${siteConfig.url}/${locale}/models`;

  return {
    title: copy.title,
    description: copy.description,
    alternates: {
      canonical,
      languages: {
        en: `${siteConfig.url}/en/models`,
        zh: `${siteConfig.url}/zh/models`,
      },
    },
    openGraph: {
      title: copy.title,
      description: copy.description,
      type: "website",
      url: canonical,
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
