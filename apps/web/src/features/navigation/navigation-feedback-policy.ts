/**
 * 全站导航反馈的纯判定策略。
 *
 * 使用方：浏览器端导航反馈组件。该模块不依赖 DOM，可在 DB-free Vitest 中验证
 * 内部跳转、修饰键、新窗口、下载与页内锚点等边界。
 */

export type NavigationFeedbackDecision = "cancel" | "ignore" | "start";

export type NavigationClickIntent = {
  button: number;
  currentHref: string;
  download: boolean;
  feedbackPreference: string | null;
  href: string;
  modifierKey: boolean;
  target: string | null;
};

/**
 * 判断一次链接点击是否需要启动全站导航反馈。
 *
 * @param intent 已从浏览器事件和锚点读取的最小导航意图。
 * @returns `start` 表示内部页面跳转，`cancel` 表示仍停留在当前文档，其他情况
 * 返回 `ignore` 并交给浏览器原生行为处理。
 * @failure 非法 URL 或非 HTTP(S) 协议安全降级为 `ignore`，不会抛出异常。
 */
export function decideNavigationFeedback(
  intent: NavigationClickIntent
): NavigationFeedbackDecision {
  if (
    intent.button !== 0 ||
    intent.modifierKey ||
    intent.download ||
    intent.feedbackPreference === "ignore"
  ) {
    return "ignore";
  }

  const normalizedTarget = intent.target?.toLowerCase() ?? "";
  if (normalizedTarget && normalizedTarget !== "_self") {
    return "ignore";
  }

  try {
    const currentUrl = new URL(intent.currentHref);
    const targetUrl = new URL(intent.href, currentUrl);
    if (
      !["http:", "https:"].includes(targetUrl.protocol) ||
      targetUrl.origin !== currentUrl.origin
    ) {
      return "ignore";
    }

    // 仅 hash 变化不会等待新的页面内容；若此前导航尚未结束，此点击也应撤销旧反馈。
    if (
      targetUrl.pathname === currentUrl.pathname &&
      targetUrl.search === currentUrl.search
    ) {
      return "cancel";
    }

    return "start";
  } catch {
    return "ignore";
  }
}
