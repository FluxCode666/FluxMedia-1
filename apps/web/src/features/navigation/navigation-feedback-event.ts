/**
 * 程序式导航反馈事件桥。
 *
 * 使用方：无法直接改成 `Link` 的客户端入口，例如表单成功回跳、筛选器和图片参考图
 * 跳转。事件只在浏览器内存中传播，不持久化导航状态，也不改变路由行为。
 */
import { SUPPORTED_LOCALES } from "@/i18n/locale-config";
import { decideNavigationFeedback } from "./navigation-feedback-policy";

export const NAVIGATION_FEEDBACK_START_EVENT =
  "fluxmedia:navigation-feedback-start";

/**
 * 为 next-intl 的无语言前缀目标生成可比较的当前地址。
 *
 * @param currentHref 浏览器当前绝对地址。
 * @param targetHref 交给 next-intl router 的目标地址。
 * @returns 目标无语言前缀时移除当前路径前缀；显式切换语言或 URL 非法时保持原值。
 * @failure URL 解析失败时安全返回原地址，由导航策略忽略非法输入。
 */
function getComparableCurrentHref(
  currentHref: string,
  targetHref: string
): string {
  try {
    const currentUrl = new URL(currentHref);
    const targetUrl = new URL(targetHref, currentUrl);
    if (targetUrl.origin !== currentUrl.origin) return currentHref;

    const supportedLocales = new Set<string>(SUPPORTED_LOCALES);
    const targetLocale = targetUrl.pathname.split("/")[1];
    if (targetLocale && supportedLocales.has(targetLocale)) return currentHref;

    const currentLocale = currentUrl.pathname.split("/")[1];
    if (!currentLocale || !supportedLocales.has(currentLocale)) {
      return currentHref;
    }

    currentUrl.pathname =
      currentUrl.pathname === `/${currentLocale}`
        ? "/"
        : currentUrl.pathname.slice(currentLocale.length + 1);
    return currentUrl.href;
  } catch {
    return currentHref;
  }
}

/**
 * 请求根布局中的导航反馈组件立即显示进度条。
 *
 * @param href 可选的目标地址；仍停留在当前文档或非同源 HTTP(S) 地址时不发事件。
 */
export function requestNavigationFeedback(href?: string): void {
  if (typeof window === "undefined") return;
  if (
    href &&
    decideNavigationFeedback({
      button: 0,
      currentHref: getComparableCurrentHref(window.location.href, href),
      download: false,
      feedbackPreference: null,
      href,
      modifierKey: false,
      target: null,
    }) !== "start"
  ) {
    return;
  }
  window.dispatchEvent(new Event(NAVIGATION_FEEDBACK_START_EVENT));
}
