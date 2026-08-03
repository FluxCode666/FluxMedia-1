/**
 * 公开 API 接入文档路由。
 *
 * 与仅管理员可见的 /docs 分离，承载外部开发者需要的模型、积分、图片与视频端点，
 * 并生成双语 canonical、Open Graph 与面包屑结构化数据。
 */
import { siteConfig } from "@repo/shared/config";
import type { Metadata } from "next";

import { BreadcrumbJsonLd } from "@/components/seo/json-ld";
import { ApiIntegrationDocs } from "@/features/docs/api-integration-docs";

/** 按当前语言生成公开接入文档的搜索与分享元数据。 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const isZh = locale === "zh";
  const title = isZh ? "API 接入文档" : "API Integration Guide";
  const description = isZh
    ? "FluxMedia 外部媒体 API 接入参考，包含模型列表、积分额度、生成、编辑和任务查询端点。"
    : "FluxMedia external media API reference for models, credit quota, generation, editing, and task queries.";
  const url = `${siteConfig.url}/${locale}/api-docs`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
      languages: {
        en: `${siteConfig.url}/en/api-docs`,
        zh: `${siteConfig.url}/zh/api-docs`,
      },
    },
    openGraph: {
      title,
      description,
      siteName: siteConfig.name,
      type: "website",
      url,
    },
  };
}

/** 渲染无需登录的双语 API 接入文档。 */
export default async function ApiDocsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const title = locale === "zh" ? "API 接入文档" : "API Integration Guide";

  return (
    <>
      <BreadcrumbJsonLd
        items={[
          { name: locale === "zh" ? "首页" : "Home", url: `/${locale}` },
          { name: title, url: `/${locale}/api-docs` },
        ]}
      />
      <ApiIntegrationDocs locale={locale} />
    </>
  );
}
