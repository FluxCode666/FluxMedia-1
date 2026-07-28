/**
 * 站点结构化数据的纯生成器。
 *
 * 使用方：SEO JSON-LD React 组件与 Vitest；统一站点 URL、品牌、本地化描述和
 * schema 结构，不负责渲染 script，也不读取请求输入。
 */
import { siteConfig } from "@repo/shared/config";

type LocaleType = "en" | "zh";

/** 返回站点配置中的公开 Base URL。 */
const getBaseUrl = () => siteConfig.url;

/**
 * 生成站点级搜索与品牌 schema。
 *
 * @param locale - 当前页面语言。
 * @returns 本地化 WebSite 结构化数据。
 */
export function generateWebSiteSchema(locale: LocaleType) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    url: getBaseUrl(),
    description:
      locale === "en"
        ? "Create visual work with natural language, explore current runtime model categories, and integrate FluxMedia through its existing API."
        : "用自然语言创作视觉作品，浏览当前运行时模型分类，并通过现有 API 集成 FluxMedia。",
    inLanguage: locale === "en" ? "en-US" : "zh-CN",
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${getBaseUrl()}/{locale}/blog?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

/**
 * 生成品牌组织 schema。
 *
 * @returns Organization 结构化数据；所有社媒地址为空时省略 sameAs。
 */
export function generateOrganizationSchema() {
  const sameAs = [siteConfig.links.twitter, siteConfig.links.github]
    .map((link) => link.trim())
    .filter((link) => link.length > 0);

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: getBaseUrl(),
    logo: `${getBaseUrl()}${siteConfig.logo}`,
    ...(sameAs.length > 0 ? { sameAs } : {}),
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: siteConfig.author.email,
    },
  };
}

/**
 * 文章 schema 输入。
 */
export interface ArticleSchemaInput {
  title: string;
  description: string;
  slug: string;
  locale: LocaleType;
  publishedAt: string;
  updatedAt?: string;
  author?: string;
  image?: string;
  tags?: string[];
}

/**
 * 生成博客文章 schema。
 *
 * @param input - 已由调用方校验的文章公开字段。
 * @returns Article 结构化数据；可选图片与标签为空时省略对应字段。
 */
export function generateArticleSchema(input: ArticleSchemaInput) {
  const {
    title,
    description,
    slug,
    locale,
    publishedAt,
    updatedAt,
    author,
    image,
    tags,
  } = input;

  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description,
    url: `${getBaseUrl()}/${locale}/blog/${slug}`,
    inLanguage: locale === "en" ? "en-US" : "zh-CN",
    datePublished: publishedAt,
    dateModified: updatedAt || publishedAt,
    author: {
      "@type": "Person",
      name: author || siteConfig.author.name,
    },
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      logo: {
        "@type": "ImageObject",
        url: `${getBaseUrl()}${siteConfig.logo}`,
      },
    },
    ...(image && {
      image: {
        "@type": "ImageObject",
        url: image.startsWith("http") ? image : `${getBaseUrl()}${image}`,
      },
    }),
    ...(tags && tags.length > 0 && { keywords: tags.join(", ") }),
  };
}

/**
 * FAQ 公开问答字段。
 */
export interface FAQItem {
  question: string;
  answer: string;
}

/**
 * 生成 FAQ 区块 schema。
 *
 * @param faqs - 与页面可见内容共用的问答列表。
 * @returns 按输入顺序生成的 FAQPage 结构化数据。
 */
export function generateFAQSchema(faqs: readonly FAQItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}

/**
 * 面包屑公开字段。
 */
export interface BreadcrumbItem {
  name: string;
  url: string;
}

/**
 * 生成导航面包屑 schema。
 *
 * @param items - 已排序的面包屑列表。
 * @returns BreadcrumbList 结构化数据；相对路径自动拼接站点 URL。
 */
export function generateBreadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url.startsWith("http")
        ? item.url
        : `${getBaseUrl()}${item.url}`,
    })),
  };
}

/**
 * 生成首页软件产品 schema。
 *
 * @param locale - 当前页面语言。
 * @returns 不含报价或价格信息的本地化 SoftwareApplication 结构化数据。
 */
export function generateSoftwareApplicationSchema(locale: LocaleType) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: siteConfig.name,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Web",
    url: getBaseUrl(),
    description:
      locale === "en"
        ? "Create visual work with natural language, explore current runtime model categories, and connect through the existing API integration."
        : "用自然语言创作视觉作品，浏览当前运行时模型分类，并通过现有 API 完成集成。",
  };
}
