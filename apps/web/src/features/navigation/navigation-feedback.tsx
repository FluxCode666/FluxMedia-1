/**
 * 全站客户端导航反馈组件。
 *
 * 使用方：locale 根布局。组件在内部链接点击或浏览器前进/后退时立即显示顶部进度条，
 * 并在 App Router 提交新路径或查询参数后收起；页面自身的 loading.tsx 继续负责骨架屏。
 */
"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NAVIGATION_FEEDBACK_START_EVENT } from "./navigation-feedback-event";
import { decideNavigationFeedback } from "./navigation-feedback-policy";

/**
 * 监听全站导航意图并渲染不阻塞交互的顶部进度条。
 *
 * @returns 导航中显示的视觉进度条和读屏 live region；空闲时仅保留隐藏播报区。
 * @sideEffects 订阅 document click 与 window popstate，路由提交后更新本地状态。
 * @failure 非法、外部、下载、新窗口及显式忽略的链接均安全跳过。
 */
export function NavigationFeedback() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("NavigationFeedback");
  const [isNavigating, setIsNavigating] = useState(false);
  const previousRouteKeyRef = useRef<string | null>(null);
  const routeKey = useMemo(
    () => `${pathname}?${searchParams.toString()}`,
    [pathname, searchParams]
  );

  const start = useCallback(() => setIsNavigating(true), []);
  const cancel = useCallback(() => setIsNavigating(false), []);

  useEffect(() => {
    if (previousRouteKeyRef.current === null) {
      previousRouteKeyRef.current = routeKey;
      return;
    }
    if (previousRouteKeyRef.current === routeKey) return;
    previousRouteKeyRef.current = routeKey;
    cancel();
  }, [cancel, routeKey]);

  useEffect(() => {
    /** 从事件目标向上定位真实链接，并按纯策略开启或撤销反馈。 */
    const handleDocumentClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;

      const decision = decideNavigationFeedback({
        button: event.button,
        currentHref: window.location.href,
        download: anchor.hasAttribute("download"),
        feedbackPreference: anchor.getAttribute("data-navigation-feedback"),
        href: anchor.href,
        modifierKey:
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
        target: anchor.getAttribute("target"),
      });

      if (decision === "start") start();
      if (decision === "cancel") cancel();
    };

    // 捕获阶段先于 Next.js Link 的异步导航，保证用户按下链接后同一帧内获得反馈。
    document.addEventListener("click", handleDocumentClick, true);
    window.addEventListener(NAVIGATION_FEEDBACK_START_EVENT, start);
    window.addEventListener("popstate", start);
    window.addEventListener("pageshow", cancel);
    return () => {
      document.removeEventListener("click", handleDocumentClick, true);
      window.removeEventListener(NAVIGATION_FEEDBACK_START_EVENT, start);
      window.removeEventListener("popstate", start);
      window.removeEventListener("pageshow", cancel);
    };
  }, [cancel, start]);

  return (
    <>
      {isNavigating ? (
        <div
          aria-label={t("loading")}
          aria-valuetext={t("loading")}
          className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden bg-primary/15"
          role="progressbar"
        >
          <span className="block h-full w-2/5 bg-primary motion-safe:animate-[navigation-progress_1.15s_ease-in-out_infinite] motion-reduce:w-full" />
        </div>
      ) : null}
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        {isNavigating ? t("loading") : ""}
      </span>
    </>
  );
}
