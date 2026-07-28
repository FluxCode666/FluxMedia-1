/**
 * 官网首页连续服务端内容编排。
 *
 * 使用方：首页路由；按首屏、模型、快速集成、作品、可靠性、FAQ、合层结尾的正常
 * 文档流组合各区块。全部核心内容默认可见，不依赖固定画布、长滚动或客户端脚本。
 */
import { Button } from "@repo/ui/components/button";
import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/routing";

import { HOMEPAGE_ARTWORKS } from "./homepage-artworks";
import {
  HomepageFaq,
  type HomepageFaqItem,
  parseHomepageFaqItems,
} from "./homepage-faq";
import { HomepageFooter } from "./homepage-footer";
import { HomepageIntegration } from "./homepage-integration";
import {
  getHomepageModelCatalogConsumers,
  HomepageModelCatalog,
} from "./homepage-model-catalog";
import { HomepageMotion } from "./homepage-motion";
import type { HomepagePageData } from "./homepage-page-data";
import { HomepageReliability } from "./homepage-reliability";

/**
 * 渲染双语、作品主导的完整首页。
 *
 * @param props - 当前 locale 与已在服务端收窄的页面数据。
 * @returns 正常文档流中的所有首页区块；首尾 CTA 复用同一 href。
 */
export async function HomepageContent({
  locale,
  data,
  faqItems,
}: {
  locale: string;
  data: HomepagePageData;
  faqItems?: readonly HomepageFaqItem[];
}) {
  const t = await getTranslations({ locale, namespace: "Homepage" });
  const visibleFaqItems = faqItems ?? parseHomepageFaqItems(t.raw("faq.items"));
  const modelCatalogs = getHomepageModelCatalogConsumers(data.catalog);

  return (
    <HomepageMotion>
      <section
        aria-labelledby="homepage-hero-title"
        className="relative isolate overflow-hidden border-b border-border px-4 py-10 sm:px-6 sm:py-14 lg:flex lg:min-h-[calc(100svh-4rem)] lg:items-center lg:px-8 lg:py-16"
        data-homepage-motion="hero"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_86%_14%,color-mix(in_oklab,var(--destructive)_7%,transparent),transparent_28%),linear-gradient(to_bottom,color-mix(in_oklab,var(--muted)_35%,transparent),transparent_55%)]"
        />
        <div className="mx-auto w-full max-w-7xl">
          <div className="grid gap-12 lg:grid-cols-[minmax(22.5rem,0.82fr)_minmax(34rem,1.18fr)] lg:items-center lg:gap-[clamp(2.75rem,6vw,6.5rem)]">
            <div className="relative z-10 min-w-0">
              <p
                className="font-mono text-xs uppercase tracking-[0.24em] text-destructive"
                data-homepage-motion="hero-copy"
              >
                {t("hero.eyebrow")}
              </p>
              <h1
                className="mt-5 max-w-3xl font-serif text-4xl font-medium leading-[0.94] tracking-[-0.055em] sm:text-5xl lg:text-[clamp(3.75rem,5.3vw,4.75rem)]"
                data-homepage-motion="hero-copy"
                id="homepage-hero-title"
              >
                {t("hero.titleLead")}
                <span className="mt-1 block italic text-destructive">
                  {t("hero.titleAccent")}
                </span>
              </h1>
              <p
                className="mt-6 max-w-xl text-sm leading-7 text-muted-foreground sm:text-base"
                data-homepage-motion="hero-copy"
              >
                {t("hero.description")}
              </p>
              <div
                className="mt-8 flex flex-wrap gap-3"
                data-homepage-motion="hero-copy"
              >
                <Button asChild className="rounded-full px-6" size="lg">
                  <Link href={data.ctaHref}>
                    {t("hero.cta")}
                    <ArrowUpRight className="size-4" />
                  </Link>
                </Button>
              </div>
              <p
                className="mt-10 border-t border-border pt-4 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                data-homepage-motion="hero-copy"
              >
                Prompt → Model → Result / One continuous flow
              </p>
            </div>

            <figure
              className="relative min-w-0 pb-8 lg:top-10 lg:pb-0"
              data-homepage-motion="hero-artwork"
            >
              <div
                className="relative aspect-[4/5] overflow-hidden rounded-lg border border-border/80 bg-muted/25 shadow-whisper sm:aspect-[5/4]"
                data-homepage-motion="hero-parallax"
              >
                <Image
                  alt={t("artworks.alts.mountain")}
                  className="object-cover"
                  fill
                  loading="eager"
                  priority
                  sizes="(max-width: 1023px) 94vw, 55vw"
                  src="/cinema/wall/w02.webp"
                />
                <div
                  aria-hidden="true"
                  className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-white/5"
                />
              </div>
              <figcaption className="absolute inset-x-4 bottom-12 rounded-md border border-white/10 bg-[#11100f]/92 p-4 text-[#f6f1e7] shadow-menu backdrop-blur-md sm:inset-x-6 sm:bottom-14 lg:-left-[4.5rem] lg:right-auto lg:bottom-10 lg:w-[54%]">
                <div className="flex items-center justify-between gap-4 font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
                  <span>{t("hero.promptLabel")} / 01</span>
                  <span>{t("hero.artworkFormat")}</span>
                </div>
                <p className="mt-2 font-serif text-sm leading-snug sm:text-base">
                  {t("hero.prompt")}
                </p>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      <div data-homepage-motion="model">
        <HomepageModelCatalog
          catalog={modelCatalogs.preview}
          copy={{
            eyebrow: t("models.eyebrow"),
            title: t("models.title"),
            description: t("models.description"),
            previewLabel: t("models.previewLabel"),
            countLabel: t("models.countLabel"),
            unavailable: t("models.unavailable"),
            supportedLabel: t("models.supportedLabel"),
            viewAll: t("models.viewAll"),
            label: t("models.label"),
            empty: t("models.empty"),
            categories: {
              image: {
                label: t("models.categories.image.label"),
                description: t("models.categories.image.description"),
              },
              video: {
                label: t("models.categories.video.label"),
                description: t("models.categories.video.description"),
              },
            },
          }}
        />
      </div>

      <div data-homepage-motion="reveal">
        <HomepageIntegration
          catalog={modelCatalogs.integration}
          locale={locale}
        />
      </div>

      <section
        aria-labelledby="homepage-work-title"
        className="scroll-mt-24 bg-background px-4 py-6 text-[#f6f1e7] sm:px-6 sm:py-8 lg:px-8 lg:py-10"
        id="work"
      >
        <div className="mx-auto w-full max-w-7xl rounded-lg bg-[#11100f] px-6 py-14 shadow-menu sm:px-10 sm:py-16 lg:px-12 lg:py-20">
          <div
            className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:items-end"
            data-homepage-motion="reveal"
          >
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-white/45">
                {t("artworks.eyebrow")}
              </p>
              <h2
                className="mt-4 max-w-3xl font-serif text-4xl font-medium leading-[1.04] tracking-[-0.025em] sm:text-5xl lg:text-6xl"
                id="homepage-work-title"
              >
                {t("artworks.title")}
              </h2>
            </div>
            <p className="max-w-2xl text-sm leading-7 text-white/55 lg:justify-self-end">
              {t("artworks.description")}
            </p>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-3 border-t border-white/25 pt-8 sm:grid-cols-3 lg:grid-cols-6 lg:gap-4">
            {HOMEPAGE_ARTWORKS.slice(0, 6).map((artwork) => (
              <figure
                className="min-w-0"
                data-homepage-motion="artwork"
                key={artwork.src}
              >
                <Image
                  alt={t(artwork.altKey)}
                  className="aspect-[3/4] w-full rounded-sm border border-white/15 object-cover grayscale-[0.18]"
                  height={960}
                  sizes="(max-width: 640px) 46vw, (max-width: 1024px) 30vw, 15vw"
                  src={artwork.src}
                  width={720}
                />
              </figure>
            ))}
          </div>
        </div>
      </section>

      <HomepageReliability
        canToggle={data.canToggleSlaStatus}
        copy={{
          eyebrow: t("reliability.eyebrow"),
          title: t("reliability.title"),
          description: t("reliability.description"),
          availability: t("reliability.availability"),
          recentSuccessRate: t("reliability.recentSuccessRate"),
          insufficient: t("reliability.insufficient"),
          unavailable: t("reliability.unavailable"),
          hiddenTitle: t("reliability.hiddenTitle"),
          hiddenDescription: t("reliability.hiddenDescription"),
        }}
        locale={locale}
        state={data.reliability}
      />

      <HomepageFaq
        description={t("faq.description")}
        eyebrow={t("faq.eyebrow")}
        items={visibleFaqItems}
        title={t("faq.title")}
      />

      <HomepageFooter
        copy={{
          eyebrow: t("footer.eyebrow"),
          title: t("footer.title"),
          description: t("footer.description"),
          cta: t("footer.cta"),
          brandDescription: t("footer.brandDescription"),
          siteLabel: t("footer.siteLabel"),
          legalLabel: t("footer.legalLabel"),
          models: t("footer.models"),
          docs: t("footer.docs"),
          contact: t("footer.contact"),
          terms: t("footer.terms"),
          privacy: t("footer.privacy"),
          cookie: t("footer.cookie"),
          copyright: t("footer.copyright"),
        }}
        ctaHref={data.ctaHref}
      />
    </HomepageMotion>
  );
}
