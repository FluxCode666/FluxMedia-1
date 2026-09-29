import { Providers } from "@repo/shared/components";
import { siteConfig } from "@repo/shared/config";
import { getLocale, getMessages } from "@repo/shared/platform/intl";
import type { Metadata } from "@repo/shared/platform/metadata";
import { Suspense, useEffect } from "react";
import { Toaster } from "sonner";
import { IntlProvider } from "use-intl";
import { Analytics } from "@/features/analytics";
import { CookieConsent } from "@/features/marketing/components/cookie-consent";
import { NavigationFeedback } from "@/features/navigation/navigation-feedback";

/**
 * 生成 metadata(站点级 + hreflang)
 *
 * WHY 合并在此:本文件即最顶层布局,
 * 站点级 metadata 与按 locale 的 alternates 必须在同一处产出。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const baseUrl = siteConfig.url;

  return {
    title: {
      default: siteConfig.name,
      template: `%s | ${siteConfig.name}`,
    },
    description: siteConfig.description,
    keywords: [...siteConfig.keywords],
    authors: [{ name: siteConfig.author.name, url: siteConfig.author.url }],
    creator: siteConfig.author.name,
    metadataBase: new URL(siteConfig.url),
    openGraph: {
      type: "website",
      locale: locale === "zh" ? "zh_CN" : "en_US",
      url: `${baseUrl}/${locale}`,
      title: siteConfig.name,
      description: siteConfig.description,
      siteName: siteConfig.name,
      images: [
        {
          url: siteConfig.ogImage,
          width: 1200,
          height: 630,
          alt: siteConfig.name,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: siteConfig.name,
      description: siteConfig.description,
      images: [siteConfig.ogImage],
    },
    manifest: "/site.webmanifest",
    alternates: {
      canonical: `${baseUrl}/${locale}`,
      languages: {
        en: `${baseUrl}/en`,
        zh: `${baseUrl}/zh`,
        "x-default": `${baseUrl}/en`,
      },
    },
  };
}

/** 让 <html lang> 跟随路由语言，供读屏与浏览器翻译识别。 */
function DocumentLanguage({ locale }: { locale: string }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return null;
}

/**
 * 语言布局（应用最顶层布局）。
 *
 * 功能:
 * - 语言参数由路由运行时校验，不支持的语言在进入本布局前已渲染 404
 * - html lang 按 locale 同步
 * - 提供国际化上下文 (IntlProvider)
 * - 包装 Providers (主题等)
 * - 全局组件 (CookieConsent, Toaster)
 */
export default async function LocaleLayout({
  children,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);

  return (
    <IntlProvider locale={locale} messages={messages} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}>
      <DocumentLanguage locale={locale} />
      <Providers>
        <Suspense fallback={null}>
          <NavigationFeedback />
        </Suspense>
        {children}
        <CookieConsent />
        <Toaster richColors position="top-right" />
        <Analytics />
      </Providers>
    </IntlProvider>
  );
}
