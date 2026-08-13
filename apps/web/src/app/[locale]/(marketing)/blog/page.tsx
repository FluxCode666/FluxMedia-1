import { siteConfig } from "@repo/shared/config";
import { Separator } from "@repo/ui/components/separator";
import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/seo/json-ld";
import { loadBlogIndexPageData } from "@/features/content/content-index-page-data";
import {
  buildContentIndexPageSizeHref,
  type ContentIndexSearchParams,
  contentPaginationNames,
  parseContentIndexPagination,
} from "@/features/content/content-index-pagination";
import { UrlPaginationControls } from "@/features/pagination/pagination-controls";
import { loadPaginationConfig } from "@/features/pagination/server";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";

import { BlogPostCard } from "./blog-post-card";

/**
 * 生成博客列表页 Metadata
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const isZh = locale === "zh";

  const title = isZh ? "博客文章" : "Blog Posts";
  const description = isZh
    ? "发现 FluxMedia 团队的最新见解、教程和更新。了解产品最新动态。"
    : "Discover the latest insights, tutorials, and updates from the FluxMedia team. Learn about the latest product news.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url: `${siteConfig.url}/${locale}/blog`,
      siteName: siteConfig.name,
    },
    alternates: {
      canonical: `${siteConfig.url}/${locale}/blog`,
      languages: {
        en: `${siteConfig.url}/en/blog`,
        zh: `${siteConfig.url}/zh/blog`,
      },
    },
  };
}

/**
 * 博客列表页面
 *
 * 显示当前语言的所有博客文章
 */
export default async function BlogPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<ContentIndexSearchParams>;
}) {
  const [{ locale }, rawSearchParams, paginationConfig] = await Promise.all([
    params,
    searchParams,
    loadPaginationConfig(),
  ]);
  const safeLocale = locale === "zh" ? "zh" : "en";
  const requested = parseContentIndexPagination(
    rawSearchParams,
    paginationConfig
  );
  const result = await loadBlogIndexPageData({
    locale: safeLocale,
    page: requested.page,
    pageSize: requested.pageSize,
  });
  const pathname = `/${safeLocale}/blog`;

  return (
    <div className="container mx-auto max-w-5xl py-20">
      {/* Breadcrumb JSON-LD */}
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: `/${locale}` },
          {
            name: locale === "zh" ? "博客" : "Blog",
            url: `/${locale}/blog`,
          },
        ]}
      />

      {/* Header - 衬线标题 + 编辑部式入场 */}
      <div className="mb-16 text-center animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none">
        <h1 className="font-serif text-4xl font-medium tracking-tight md:text-5xl">
          {locale === "zh" ? "博客文章" : "Blog Posts"}
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          {locale === "zh"
            ? "发现 FluxMedia 团队的最新见解、教程和更新。了解产品最新动态。"
            : "Discover the latest insights, tutorials, and updates from the FluxMedia team. Learn about the latest product news."}
        </p>
      </div>

      {/* Posts List */}
      {result.records.length > 0 ? (
        <div className="space-y-12">
          {result.records.map((post, index) => {
            return (
              // 列表项入场错峰:按索引 70ms 递增(封顶 6 档),fill-mode 用
              // backwards 保证延迟期间停留在动画首帧(透明),避免闪现跳变。
              <div
                key={post.slug}
                className="animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
                style={{
                  animationDelay: `${Math.min(index, 6) * 70}ms`,
                  animationFillMode: "backwards",
                }}
              >
                <BlogPostCard
                  slug={post.slug}
                  title={post.title}
                  description={post.description}
                  date={post.date}
                  author={post.author}
                  tags={post.tags}
                />
                {index < result.records.length - 1 && (
                  <Separator className="mt-12" />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border py-24 text-center text-muted-foreground">
          {locale === "zh" ? "暂无博客文章" : "No blog posts yet"}
        </div>
      )}
      <div className="mt-12 flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>
            {safeLocale === "zh"
              ? `共 ${result.totalCount} 篇文章`
              : `${result.totalCount} posts total`}
          </span>
          <UrlPageSizeSelect
            value={result.pageSize}
            options={paginationConfig.pageSizeOptions.map((pageSize) => ({
              size: pageSize,
              href: buildContentIndexPageSizeHref(
                pathname,
                rawSearchParams,
                pageSize
              ),
            }))}
            label={safeLocale === "zh" ? "每页文章数" : "Posts per page"}
            itemSuffix={safeLocale === "zh" ? " 篇" : " / page"}
          />
        </div>
        <UrlPaginationControls
          page={result.page}
          totalPages={result.totalPages}
          names={contentPaginationNames}
          ariaLabel={safeLocale === "zh" ? "博客分页" : "Blog pagination"}
          pageSelectLabel={safeLocale === "zh" ? "选择页码" : "Select page"}
          previousLabel={safeLocale === "zh" ? "上一页" : "Previous"}
          nextLabel={safeLocale === "zh" ? "下一页" : "Next"}
          getPageLabel={(page, isCurrent) =>
            safeLocale === "zh"
              ? isCurrent
                ? `第 ${page} 页，当前页`
                : `前往第 ${page} 页`
              : isCurrent
                ? `Page ${page}, current page`
                : `Go to page ${page}`
          }
        />
      </div>
    </div>
  );
}
