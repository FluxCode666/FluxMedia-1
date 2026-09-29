/**
 * 带语言前缀的导航。
 *
 * 使用方：站内页面与组件。站内绝对路径自动补当前语言前缀，usePathname 返回去掉
 * 语言前缀的路径；切换语言时通过 `{ locale }` 选项指定目标语言。
 */
import BaseLink, { formatHref, type LinkProps as BaseLinkProps, type UrlObject } from "@repo/shared/platform/link";
import {
  redirect as baseRedirect,
  usePathname as useBasePathname,
  useRouter as useBaseRouter,
} from "@repo/shared/platform/navigation";
import { forwardRef, useMemo } from "react";
import { useLocale } from "use-intl";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locale-config";

type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * 国际化路由配置
 */
export const routing = {
  locales: SUPPORTED_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
} as const;

/** 判断字符串是否为受支持的语言代码。 */
export function isSupportedLocale(value: string | undefined): value is Locale {
  return SUPPORTED_LOCALES.includes(value as Locale);
}

/** 去掉路径开头的语言段；无语言段时原样返回。 */
export function stripLocale(pathname: string): string {
  const segment = pathname.split("/")[1];
  if (!isSupportedLocale(segment)) return pathname;
  const rest = pathname.slice(segment.length + 1);
  return rest === "" ? "/" : rest;
}

type HrefInput = string | (UrlObject & { params?: unknown });

/** 给站内绝对路径补语言前缀；已有语言前缀时替换为目标语言。 */
export function localizeHref(href: HrefInput, locale: string): string {
  const url = formatHref(href);
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  const match = /^([^?#]*)(.*)$/u.exec(url);
  const path = stripLocale(match?.[1] ?? url);
  const suffix = match?.[2] ?? "";
  return `/${locale}${path === "/" ? "" : path}${suffix}`;
}

type LinkProps = Omit<BaseLinkProps, "href"> & { href: HrefInput; locale?: string };

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, locale, ...rest },
  ref
) {
  const current = useLocale();
  return <BaseLink ref={ref} href={localizeHref(href, locale ?? current)} {...rest} />;
});

type NavigateOptions = { locale?: string; scroll?: boolean };

/** 返回自动补语言前缀的路由对象。 */
export function useRouter() {
  const router = useBaseRouter();
  const current = useLocale();
  return useMemo(
    () => ({
      ...router,
      push: (href: HrefInput, options?: NavigateOptions) =>
        router.push(localizeHref(href, options?.locale ?? current), options),
      replace: (href: HrefInput, options?: NavigateOptions) =>
        router.replace(localizeHref(href, options?.locale ?? current), options),
      prefetch: (_href: HrefInput) => undefined,
    }),
    [router, current]
  );
}

/** 当前路径（不含语言前缀）。 */
export function usePathname(): string {
  return stripLocale(useBasePathname());
}

/** 页面加载阶段跳转到指定语言下的站内路径。 */
export function redirect({ href, locale }: { href: HrefInput; locale: string }): never {
  return baseRedirect(localizeHref(href, locale));
}

/** 计算指定语言下的完整站内路径。 */
export function getPathname({ href, locale }: { href: HrefInput; locale: string }): string {
  return localizeHref(href, locale);
}
