import { createNavigation } from "next-intl/navigation";
import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locale-config";

/**
 * 国际化路由配置
 *
 * 定义支持的语言和默认语言
 */
export const routing = defineRouting({
  // 支持的语言列表
  locales: SUPPORTED_LOCALES,
  // 默认语言
  defaultLocale: DEFAULT_LOCALE,
});

/**
 * 导出国际化导航组件和钩子
 *
 * 使用这些替代 next/link 和 next/navigation
 * 以确保正确处理语言前缀
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
