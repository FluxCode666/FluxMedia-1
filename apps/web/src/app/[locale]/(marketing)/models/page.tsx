/**
 * 本地化公开模型广场页面。
 *
 * 使用方是营销 Header、Footer、sitemap 与站外访问者；页面只消费公开 UOL DTO，
 * 显式禁用 Full Route Cache，并区分空目录与依赖失败。
 */
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { ModelMarketplaceBrowser } from "@/features/model-marketplace/model-marketplace-browser";
import {
  buildModelMarketplaceMetadata,
  normalizeModelMarketplaceMetadataLocale,
} from "@/features/model-marketplace/model-marketplace-metadata";
import { loadModelMarketplacePageData } from "@/features/model-marketplace/page-data";

/** 运行时目录和展示开关必须逐请求读取，不能固化进 Full Route Cache。 */
export const dynamic = "force-dynamic";

/**
 * 生成当前语言的模型广场 SEO Metadata。
 *
 * @param props - Next.js 异步 locale 路由参数。
 * @returns 本地化标题、说明、canonical 与双语 alternates。
 * @sideEffects 无。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return buildModelMarketplaceMetadata(
    normalizeModelMarketplaceMetadataLocale(locale)
  );
}

/**
 * 渲染公开模型广场。
 *
 * @returns 标题说明、公开模型浏览器，或稳定的空目录/不可用状态。
 * @sideEffects 通过页面数据边界调用一次公开 UOL operation，并读取当前语言文案。
 * @failure 公开依赖失败时返回友好不可用状态，不暴露底层错误或伪造空目录。
 */
export default async function ModelsPage() {
  const [t, pageData] = await Promise.all([
    getTranslations("ModelMarketplace"),
    loadModelMarketplacePageData(),
  ]);

  return (
    <div className="border-b bg-background">
      <section className="border-b border-border/60 bg-muted/20">
        <div className="container py-16 sm:py-20 lg:py-24">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">
            {t("eyebrow")}
          </p>
          <h1 className="mt-5 max-w-4xl font-serif text-4xl font-medium leading-[1.05] tracking-tight sm:text-6xl">
            {t("title")}
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            {t("description")}
          </p>
        </div>
      </section>

      <section className="container py-10 sm:py-14 lg:py-16">
        {pageData.status === "unavailable" ? (
          <div className="flex min-h-96 items-center justify-center rounded-xl border border-dashed bg-muted/20 px-6 text-center">
            <div className="max-w-md">
              <h2 className="font-serif text-2xl font-medium">
                {t("unavailable.title")}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {t("unavailable.description")}
              </p>
            </div>
          </div>
        ) : pageData.models.length === 0 ? (
          <div className="flex min-h-96 items-center justify-center rounded-xl border border-dashed bg-muted/20 px-6 text-center">
            <div className="max-w-md">
              <h2 className="font-serif text-2xl font-medium">
                {t("empty.title")}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {t("empty.description")}
              </p>
            </div>
          </div>
        ) : (
          <ModelMarketplaceBrowser models={pageData.models} />
        )}
      </section>
    </div>
  );
}
