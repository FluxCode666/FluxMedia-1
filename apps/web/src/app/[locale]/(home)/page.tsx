/**
 * FluxMedia 本地化官网首页路由。
 *
 * 使用方：`/[locale]` 首页；专属 Route Group 保证布局不附加营销共享 Footer。
 * 关键依赖：首页安全数据装配器与连续 Server Component 内容。
 */
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { HomePageJsonLd } from "@/components/seo/json-ld";
import { getCurrentDocumentationBaseUrl } from "@/features/docs/documentation-base-url-server";
import { HomepageContent } from "@/features/marketing/homepage/homepage-content";
import { parseHomepageFaqItems } from "@/features/marketing/homepage/homepage-faq";
import {
  buildHomepageMetadata,
  normalizeHomepageMetadataLocale,
} from "@/features/marketing/homepage/homepage-metadata";
import { loadHomepagePageData } from "@/features/marketing/homepage/homepage-page-data";

export const dynamic = "force-dynamic";

/**
 * 生成当前首页 Metadata。
 *
 * @param params - Next.js 提供的异步语言路由参数。
 * @returns 由首页纯构建器生成的双语索引内容；未知语言安全回退为英文。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return buildHomepageMetadata(normalizeHomepageMetadataLocale(locale));
}

/**
 * 读取已收窄首页数据并服务端输出连续双语页面。
 *
 * @param params - Next.js 提供的异步语言路由参数。
 * @returns 首页 JSON-LD 与可见正文；FAQ 只解析一次并共享同一数组。
 * @throws 本地化 FAQ 不符合 strict schema 时显式失败，避免索引与正文分叉。
 */
export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const normalizedLocale = normalizeHomepageMetadataLocale(locale);
  const [pageData, t, baseUrl] = await Promise.all([
    loadHomepagePageData(),
    getTranslations({ locale, namespace: "Homepage" }),
    getCurrentDocumentationBaseUrl(),
  ]);
  const faqItems = parseHomepageFaqItems(t.raw("faq.items"));

  return (
    <>
      <HomePageJsonLd faqs={faqItems} locale={normalizedLocale} />

      <HomepageContent
        baseUrl={baseUrl}
        data={pageData}
        faqItems={faqItems}
        locale={locale}
      />
    </>
  );
}
