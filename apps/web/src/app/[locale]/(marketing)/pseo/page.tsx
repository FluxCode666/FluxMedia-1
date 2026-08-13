import { Badge } from "@repo/ui/components/badge";
import { Card, CardContent } from "@repo/ui/components/card";
import { ArrowUpRight, Database, LayoutTemplate, Route } from "lucide-react";
import { loadPseoIndexPageData } from "@/features/content/content-index-page-data";
import {
  buildContentIndexPageSizeHref,
  type ContentIndexSearchParams,
  contentPaginationNames,
  parseContentIndexPagination,
} from "@/features/content/content-index-pagination";
import { UrlPaginationControls } from "@/features/pagination/pagination-controls";
import { loadPaginationConfig } from "@/features/pagination/server";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";
import { Link } from "@/i18n/routing";

export default async function PseoIndexPage({
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
  const result = await loadPseoIndexPageData({
    locale: safeLocale,
    page: requested.page,
    pageSize: requested.pageSize,
  });
  const pathname = `/${safeLocale}/pseo`;
  const isZh = safeLocale === "zh";

  const overviewCards = isZh
    ? [
        {
          title: "JSON 数据驱动",
          description: "每个 PSEO 页面都来自结构化 JSON 配置。",
          icon: Database,
        },
        {
          title: "复用页面模块",
          description: "Hero、特性、场景、FAQ、CTA 可复用组合。",
          icon: LayoutTemplate,
        },
        {
          title: "多语言输出",
          description: "自动匹配当前语言版本内容。",
          icon: Route,
        },
      ]
    : [
        {
          title: "JSON-first data",
          description:
            "Every PSEO page is generated from structured JSON fields.",
          icon: Database,
        },
        {
          title: "Reusable sections",
          description:
            "Hero, features, use cases, FAQ, and CTA reuse the same UI blocks.",
          icon: LayoutTemplate,
        },
        {
          title: "Locale-aware",
          description:
            "Switch locales to render the matching content automatically.",
          icon: Route,
        },
      ];

  return (
    <section className="container py-20 md:py-28">
      <div className="mx-auto mb-16 flex max-w-4xl flex-col items-center text-center animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none">
        <Badge
          variant="outline"
          className="mb-4 rounded-full border-border px-4 py-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground"
        >
          PSEO Framework
        </Badge>
        <h1 className="text-balance font-serif text-4xl font-medium leading-[1.1] tracking-tight md:text-5xl">
          {isZh ? "PSEO 框架演示库" : "Programmatic SEO Demo Library"}
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          {isZh
            ? "所有模板均由 JSON 数据驱动，可快速扩展到成百上千个落地页。"
            : "Templates are generated from JSON data and reusable UI blocks. Add entries to scale to thousands of landing pages."}
        </p>
      </div>

      <div className="mx-auto mb-16 grid max-w-5xl gap-6 md:grid-cols-3">
        {overviewCards.map((card, index) => {
          const Icon = card.icon;
          return (
            // 概览卡入场错峰:按索引 80ms 递增,fill-mode backwards 防闪现
            <Card
              key={card.title}
              className="border-border bg-background shadow-none animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
              style={{
                animationDelay: `${120 + index * 80}ms`,
                animationFillMode: "backwards",
              }}
            >
              <CardContent className="p-6">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-foreground/5 text-foreground">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mb-2 text-base font-medium">{card.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {card.description}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h2 className="font-serif text-2xl font-medium tracking-tight md:text-3xl">
              {isZh ? "可用模板" : "Available templates"}
            </h2>
            <p className="mt-2 leading-relaxed text-muted-foreground">
              {isZh
                ? "选择任意模板查看完整的 PSEO 落地页。"
                : "Pick any template to view the full PSEO landing page."}
            </p>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {result.records.map((page) => (
            <Card
              key={page.slug}
              className="group border-border bg-background shadow-none transition-[border-color,box-shadow,transform] duration-250 hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-whisper"
            >
              <CardContent className="flex h-full flex-col p-6">
                <div className="mb-4 flex items-center justify-between">
                  <Badge variant="secondary">{page.category}</Badge>
                  <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors duration-150 group-hover:text-foreground" />
                </div>
                <h3 className="mb-2 text-lg font-medium">{page.title}</h3>
                <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
                  {page.description}
                </p>
                <div className="mt-auto">
                  <Link
                    href={`/pseo/${page.slug}`}
                    className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {isZh ? "查看模板" : "View template"}
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="mt-10 flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>
              {isZh
                ? `共 ${result.totalCount} 个模板`
                : `${result.totalCount} templates total`}
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
              label={isZh ? "每页模板数" : "Templates per page"}
              itemSuffix={isZh ? " 个" : " / page"}
            />
          </div>
          <UrlPaginationControls
            page={result.page}
            totalPages={result.totalPages}
            names={contentPaginationNames}
            ariaLabel={isZh ? "PSEO 模板分页" : "PSEO template pagination"}
            pageSelectLabel={isZh ? "选择页码" : "Select page"}
            previousLabel={isZh ? "上一页" : "Previous"}
            nextLabel={isZh ? "下一页" : "Next"}
            getPageLabel={(page, isCurrent) =>
              isZh
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
    </section>
  );
}
