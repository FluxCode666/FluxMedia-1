/**
 * 全站客户端导航反馈组件。
 *
 * 使用方：locale 根布局。组件在内部链接点击或浏览器前进/后退时立即显示顶部进度条，
 * 并在 App Router 提交新路径或查询参数后收起；页面自身的 loading.tsx 继续负责骨架屏。
 */
"use client";

import { Progress } from "@repo/ui/components/progress";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NAVIGATION_FEEDBACK_START_EVENT } from "./navigation-feedback-event";
import { decideNavigationFeedback } from "./navigation-feedback-policy";
import {
  advanceNavigationProgress,
  NAVIGATION_PROGRESS_COMPLETE_DELAY_MS,
  NAVIGATION_PROGRESS_INITIAL,
  NAVIGATION_PROGRESS_STALE_MS,
  NAVIGATION_PROGRESS_TICK_MS,
  NAVIGATION_PROGRESS_WAITING_MAX,
} from "./navigation-progress";

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
  const [progress, setProgress] = useState<number | null>(null);
  const [progressRunId, setProgressRunId] = useState(0);
  const isActiveRef = useRef(false);
  const completionTimerRef = useRef<number | null>(null);
  const staleTimerRef = useRef<number | null>(null);
  const previousRouteKeyRef = useRef<string | null>(null);
  const routeKey = useMemo(
    () => `${pathname}?${searchParams.toString()}`,
    [pathname, searchParams]
  );

  /** 清除上一轮完成态的延迟收起计时器。 */
  const clearCompletionTimer = useCallback((): void => {
    if (completionTimerRef.current === null) return;
    window.clearTimeout(completionTimerRef.current);
    completionTimerRef.current = null;
  }, []);

  /** 清除导航失败或未提交时的最长存活兜底计时器。 */
  const clearStaleTimer = useCallback((): void => {
    if (staleTimerRef.current === null) return;
    window.clearTimeout(staleTimerRef.current);
    staleTimerRef.current = null;
  }, []);

  /** 启动一轮新的导航反馈，立即显示非零进度。 */
  const start = useCallback((): void => {
    clearCompletionTimer();
    clearStaleTimer();
    isActiveRef.current = true;
    setProgressRunId((current) => current + 1);
    setProgress(NAVIGATION_PROGRESS_INITIAL);
    staleTimerRef.current = window.setTimeout(() => {
      isActiveRef.current = false;
      staleTimerRef.current = null;
      setProgress(null);
    }, NAVIGATION_PROGRESS_STALE_MS);
  }, [clearCompletionTimer, clearStaleTimer]);

  /** 将活动导航推进到 100%；收起计时由完成态提交后的 effect 负责。 */
  const complete = useCallback((): void => {
    if (!isActiveRef.current) return;
    clearStaleTimer();
    setProgress(100);
  }, [clearStaleTimer]);

  /** 立即撤销不会离开当前文档的反馈，不播放虚假的完成动画。 */
  const reset = useCallback((): void => {
    clearCompletionTimer();
    clearStaleTimer();
    isActiveRef.current = false;
    setProgress(null);
  }, [clearCompletionTimer, clearStaleTimer]);

  const isAdvancing =
    progress !== null && progress < NAVIGATION_PROGRESS_WAITING_MAX;
  const feedbackText = progress === 100 ? t("complete") : t("loading");

  useEffect(() => {
    if (!isAdvancing) return;
    const intervalId = window.setInterval(() => {
      setProgress((current) =>
        current === null ? null : advanceNavigationProgress(current)
      );
    }, NAVIGATION_PROGRESS_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [isAdvancing]);

  useEffect(() => {
    if (progress !== 100) return;
    completionTimerRef.current = window.setTimeout(() => {
      isActiveRef.current = false;
      completionTimerRef.current = null;
      setProgress(null);
    }, NAVIGATION_PROGRESS_COMPLETE_DELAY_MS);
    return clearCompletionTimer;
  }, [clearCompletionTimer, progress]);

  useEffect(
    () => () => {
      clearCompletionTimer();
      clearStaleTimer();
    },
    [clearCompletionTimer, clearStaleTimer]
  );

  useEffect(() => {
    if (previousRouteKeyRef.current === null) {
      previousRouteKeyRef.current = routeKey;
      return;
    }
    if (previousRouteKeyRef.current === routeKey) return;
    previousRouteKeyRef.current = routeKey;
    complete();
  }, [complete, routeKey]);

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
      if (decision === "cancel") reset();
    };

    // 捕获阶段先于 Next.js Link 的异步导航，保证用户按下链接后同一帧内获得反馈。
    document.addEventListener("click", handleDocumentClick, true);
    window.addEventListener(NAVIGATION_FEEDBACK_START_EVENT, start);
    window.addEventListener("popstate", start);
    window.addEventListener("pageshow", reset);
    return () => {
      document.removeEventListener("click", handleDocumentClick, true);
      window.removeEventListener(NAVIGATION_FEEDBACK_START_EVENT, start);
      window.removeEventListener("popstate", start);
      window.removeEventListener("pageshow", reset);
    };
  }, [reset, start]);

  return (
    <>
      {progress !== null ? (
        <Progress
          aria-label={feedbackText}
          aria-valuetext={feedbackText}
          className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 rounded-none bg-primary/15"
          indicatorClassName="duration-200 ease-out motion-reduce:transition-none"
          key={progressRunId}
          value={progress}
        />
      ) : null}
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        {progress !== null ? feedbackText : ""}
      </span>
    </>
  );
}
