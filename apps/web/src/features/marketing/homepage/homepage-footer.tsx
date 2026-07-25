/**
 * 官网首页合层 CTA 与语义 Footer。
 *
 * 使用方：首页正常文档流末尾；CTA 与品牌/站点/法律链接共享同一黑色视觉图层，不
 * 渲染 Pricing、社媒标题、空链接或独立浅色 Footer。
 */
import { Button } from "@repo/ui/components/button";
import { ArrowUpRight } from "lucide-react";
import Image from "next/image";

import { Link } from "@/i18n/routing";

/** 首页合层结尾的双语可见文案。 */
export type HomepageFooterCopy = {
  eyebrow: string;
  title: string;
  description: string;
  cta: string;
  brandDescription: string;
  siteLabel: string;
  legalLabel: string;
  docs: string;
  contact: string;
  terms: string;
  privacy: string;
  cookie: string;
  copyright: string;
};

/**
 * 渲染共用 CTA href 的黑色页尾与唯一语义 Footer。
 *
 * @param props - 服务端解析的登录 CTA href 与当前语言文案。
 * @returns 无 JavaScript 可操作的创作入口、Logo、站点/法律链接和固定 2026 版权。
 */
export function HomepageFooter({
  ctaHref,
  copy,
}: {
  ctaHref: "/dashboard/generate" | "/sign-up";
  copy: HomepageFooterCopy;
}) {
  return (
    <section
      aria-labelledby="homepage-create-title"
      className="scroll-mt-24 bg-[#11100f] px-4 text-[#f6f1e7] sm:px-6 lg:px-8"
      id="create"
    >
      <div className="mx-auto flex min-h-[calc(100svh-4rem)] w-full max-w-7xl items-center justify-center border-b border-white/15 py-20 text-center lg:py-28">
        <div className="flex max-w-5xl flex-col items-center">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-[#f6f1e7]/50">
            {copy.eyebrow}
          </p>
          <h2
            className="mt-5 max-w-5xl font-serif text-5xl font-medium leading-[0.98] tracking-[-0.035em] sm:text-7xl lg:text-8xl"
            id="homepage-create-title"
          >
            {copy.title}
          </h2>
          <p className="mt-7 max-w-xl text-base leading-7 text-[#f6f1e7]/55">
            {copy.description}
          </p>
          <Button
            asChild
            className="mt-9 rounded-full bg-[#f6f1e7] px-7 text-[#11100f] hover:bg-white"
            size="lg"
          >
            <Link href={ctaHref}>
              {copy.cta}
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </div>
      </div>

      <footer className="mx-auto w-full max-w-7xl py-10">
        <div className="grid gap-10 sm:grid-cols-[1.4fr_0.7fr_0.7fr]">
          <div>
            <Link className="inline-flex items-center gap-2" href="/">
              <Image
                alt="FluxMedia"
                className="brightness-0 invert"
                height={28}
                src="/assets/icon.png"
                width={28}
              />
              <span className="font-serif text-xl font-medium">FluxMedia</span>
            </Link>
            <p className="mt-4 max-w-sm text-sm leading-6 text-[#f6f1e7]/55">
              {copy.brandDescription}
            </p>
          </div>

          <nav aria-label={copy.siteLabel}>
            <h3 className="text-xs uppercase tracking-[0.2em] text-[#f6f1e7]/45">
              {copy.siteLabel}
            </h3>
            <ul className="mt-4 space-y-3 text-sm">
              <li>
                <Link
                  className="text-[#f6f1e7]/65 transition-colors hover:text-white"
                  href="/api-docs"
                >
                  {copy.docs}
                </Link>
              </li>
              <li>
                <a
                  className="text-[#f6f1e7]/65 transition-colors hover:text-white"
                  href="mailto:support@media.flux-code.cc"
                >
                  {copy.contact}
                </a>
              </li>
            </ul>
          </nav>

          <nav aria-label={copy.legalLabel}>
            <h3 className="text-xs uppercase tracking-[0.2em] text-[#f6f1e7]/45">
              {copy.legalLabel}
            </h3>
            <ul className="mt-4 space-y-3 text-sm">
              <li>
                <Link
                  className="text-[#f6f1e7]/65 transition-colors hover:text-white"
                  href="/legal/terms"
                >
                  {copy.terms}
                </Link>
              </li>
              <li>
                <Link
                  className="text-[#f6f1e7]/65 transition-colors hover:text-white"
                  href="/legal/privacy"
                >
                  {copy.privacy}
                </Link>
              </li>
              <li>
                <Link
                  className="text-[#f6f1e7]/65 transition-colors hover:text-white"
                  href="/legal/cookie-policy"
                >
                  {copy.cookie}
                </Link>
              </li>
            </ul>
          </nav>
        </div>

        <p className="mt-10 border-t border-white/10 pt-6 text-sm text-[#f6f1e7]/45">
          {copy.copyright}
        </p>
      </footer>
    </section>
  );
}
