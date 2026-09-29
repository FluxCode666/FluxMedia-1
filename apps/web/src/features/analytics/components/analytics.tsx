import { useEffect, useState } from "react";
import { useLocation } from "react-router";

import {
  COOKIE_CONSENT_CHANGE_EVENT,
  COOKIE_CONSENT_KEY,
} from "@/features/marketing/constants";

/**
 * Analytics 组件
 *
 * 功能:
 * - 条件渲染 Google Analytics
 * - 仅在用户接受 Cookie 时加载
 * - 监听 localStorage 变化以响应用户偏好更改
 */
export function Analytics() {
  const [hasConsent, setHasConsent] = useState(false);
  const gaId = process.env.NEXT_PUBLIC_GA_ID;

  useEffect(() => {
    // 检查初始同意状态
    const checkConsent = () => {
      const consent = localStorage.getItem(COOKIE_CONSENT_KEY);
      setHasConsent(consent === "all");
    };

    checkConsent();

    // 监听 storage 事件以响应其他标签页的更改
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === COOKIE_CONSENT_KEY) {
        checkConsent();
      }
    };

    // 监听自定义事件以响应同一页面的更改
    const handleConsentChange = () => {
      checkConsent();
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(COOKIE_CONSENT_CHANGE_EVENT, handleConsentChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(
        COOKIE_CONSENT_CHANGE_EVENT,
        handleConsentChange
      );
    };
  }, []);

  // 未配置 GA ID 或未同意时不渲染
  if (!gaId || !hasConsent) {
    return null;
  }

  return <GoogleAnalytics gaId={gaId} />;
}

type GtagWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void };

/**
 * 加载 gtag.js 并在路由切换时上报页面浏览。
 *
 * @param gaId - Google Analytics 衡量 ID。
 * @sideEffects 首次挂载时向 document.head 注入 gtag 脚本；同一页面只注入一次。
 */
function GoogleAnalytics({ gaId }: { gaId: string }) {
  const location = useLocation();

  useEffect(() => {
    const win = window as GtagWindow;
    if (document.getElementById("ga-gtag")) return;
    win.dataLayer = win.dataLayer ?? [];
    win.gtag = function gtag() {
      // biome-ignore lint/complexity/noArguments: gtag 协议要求推入 arguments 对象。
      win.dataLayer?.push(arguments);
    };
    win.gtag("js", new Date());
    win.gtag("config", gaId, { send_page_view: false });
    const script = document.createElement("script");
    script.id = "ga-gtag";
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`;
    document.head.appendChild(script);
  }, [gaId]);

  useEffect(() => {
    (window as GtagWindow).gtag?.("event", "page_view", {
      page_location: window.location.href,
      page_path: `${location.pathname}${location.search}`,
    });
  }, [location.pathname, location.search]);

  return null;
}
