/**
 * 开发服务器的语言前缀跳转与 Dashboard 会话闸门。
 *
 * 使用方：vite.config.ts。生产环境由 Go backend（services/api-gateway/spa.go）把无语言
 * 前缀的页面请求 307 跳到协商出的语言，并把无会话 cookie 的 Dashboard 请求送去登录页；
 * Vite 开发服务器不经过 Go 页面层，这里按同一规则补齐，避免 `/`、`/forgot-password`
 * 等链接在开发时落到 404。修改规则时两边需同步。
 */
import type { Plugin } from "vite";

const LOCALES = ["en", "zh"];
const DEFAULT_LOCALE = "en";
const LOCALE_COOKIE = "NEXT_LOCALE";
const SESSION_COOKIES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
];
const BACKEND_NAMESPACES = [
  "/api",
  "/v1",
  "/v1beta",
  "/r",
  "/moderate",
  "/healthz",
  "/readyz",
  "/health",
  "/ready",
];

export type PageRequest = {
  method?: string;
  url?: string;
  accept?: string;
  cookie?: string;
  acceptLanguage?: string;
};

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0)
      cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

/** 与 Go 的 negotiatePageLocale 一致：cookie 优先，其次权重最高的 Accept-Language，最后英文。 */
export function negotiateLocale(
  cookieHeader: string | undefined,
  acceptLanguage: string | undefined
): string {
  const cookie = parseCookies(cookieHeader).get(LOCALE_COOKIE);
  if (cookie && LOCALES.includes(cookie)) return cookie;
  let best: { locale: string; weight: number } | undefined;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const [tag = "", params = ""] = part.trim().split(/;(.*)/u);
    let weight = 1;
    const q = params.trim();
    if (q.startsWith("q=")) {
      weight = Number.parseFloat(q.slice(2));
      if (Number.isNaN(weight)) continue;
    }
    const primary = tag.trim().toLowerCase().split("-")[0] ?? "";
    if (
      weight > 0 &&
      LOCALES.includes(primary) &&
      (!best || weight > best.weight)
    ) {
      best = { locale: primary, weight };
    }
  }
  return best?.locale ?? DEFAULT_LOCALE;
}

/**
 * 计算页面导航请求的跳转目标；不需要跳转时返回 null。
 *
 * 只处理浏览器页面导航（Accept 含 text/html）；Vite 内部模块、带扩展名的资源和代理到 Go 的
 * 后端路径都不受影响。
 */
export function devPageRedirect(request: PageRequest): string | null {
  if ((request.method !== "GET" && request.method !== "HEAD") || !request.url)
    return null;
  if (!request.accept?.includes("text/html")) return null;
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname;
  if (BACKEND_NAMESPACES.some((prefix) => hasPrefix(pathname, prefix)))
    return null;
  if (/^\/(?:@|__)/u.test(pathname) || /\.[^/]+$/u.test(pathname)) return null;

  const first = pathname.split("/")[1] ?? "";
  const prefixed = LOCALES.includes(first);
  const rest = prefixed ? pathname.slice(first.length + 1) || "/" : pathname;
  const locale = prefixed
    ? first
    : negotiateLocale(request.cookie, request.acceptLanguage);

  const cookies = parseCookies(request.cookie);
  if (
    hasPrefix(rest, "/dashboard") &&
    !SESSION_COOKIES.some((name) => cookies.get(name))
  ) {
    return `/${locale}/sign-in?callbackUrl=${encodeURIComponent(`${pathname}${url.search}`)}`;
  }
  if (prefixed) return null;
  return `/${locale}${pathname === "/" ? "" : pathname}${url.search}`;
}

/** 注册开发服务器中间件；只在 `vite dev` 生效，构建产物由 Go 负责同样的跳转。 */
export function devLocaleRedirect(): Plugin {
  return {
    name: "fluxmedia-dev-locale-redirect",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const target = devPageRedirect({
          method: req.method,
          url: req.url,
          accept: req.headers.accept,
          cookie: req.headers.cookie,
          acceptLanguage: req.headers["accept-language"],
        });
        if (!target) {
          next();
          return;
        }
        res.statusCode = 307;
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Location", target);
        res.end();
      });
    },
  };
}
