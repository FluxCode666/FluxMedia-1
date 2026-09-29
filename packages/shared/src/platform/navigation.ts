/**
 * SPA 导航原语。
 *
 * 使用方：页面、布局与客户端组件。它提供与原 Next.js 导航相同形状的 API
 * （useRouter/usePathname/useSearchParams/redirect/notFound），底层由 React Router 驱动；
 * 路由数据刷新通过 refreshRoutes 广播给路由运行时，由其重新执行页面加载函数。
 */
import { useMemo } from "react";
import {
  type NavigateFunction,
  useLocation,
  useMatches,
  useNavigate,
  useParams as useRouterParams,
  useSearchParams as useRouterSearchParams,
} from "react-router";

/** 页面加载阶段请求跳转；由路由运行时捕获并执行 replace 导航。 */
export class RedirectSignal extends Error {
  constructor(readonly href: string) {
    super(`Redirect to ${href}`);
    this.name = "RedirectSignal";
  }
}

/** 页面加载阶段声明资源不存在；由路由运行时渲染 404。 */
export class NotFoundSignal extends Error {
  constructor() {
    super("Not found");
    this.name = "NotFoundSignal";
  }
}

/** 中止当前页面加载并跳转到目标地址。 */
export function redirect(href: string): never {
  throw new RedirectSignal(href);
}

export const permanentRedirect = redirect;

/** 中止当前页面加载并渲染 404。 */
export function notFound(): never {
  throw new NotFoundSignal();
}

let loadingUrl: URL | null = null;

/** 路由运行时在执行页面与布局加载函数前写入本次导航的目标地址。 */
export function setLoadingUrl(url: string): void {
  loadingUrl = new URL(url);
}

/**
 * 本次导航的目标路径与查询（原服务端组件读取的请求地址）。
 *
 * 客户端导航时 window.location 仍是旧地址，加载函数应使用本函数构造回跳地址。
 */
export function getLoadingPath(): string {
  const url = loadingUrl ?? new URL(window.location.href);
  return `${url.pathname}${url.search}`;
}

const refreshListeners = new Set<() => void>();

/** 订阅路由数据刷新；返回取消订阅函数。 */
export function subscribeRouteRefresh(listener: () => void): () => void {
  refreshListeners.add(listener);
  return () => {
    refreshListeners.delete(listener);
  };
}

/** 让当前已挂载的页面与布局重新执行加载函数，保留客户端状态。 */
export function refreshRoutes(): void {
  for (const listener of refreshListeners) listener();
}

type NavigateOptions = { scroll?: boolean };

/** 把绝对同源地址收窄为路由内地址；跨域地址返回 null 交给浏览器处理。 */
export function toRouterHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (href.startsWith("?") || href.startsWith("#")) return href;
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

function navigateTo(
  navigate: NavigateFunction,
  href: string,
  replace: boolean,
  options?: NavigateOptions
) {
  const target = toRouterHref(href);
  if (target === null) {
    if (replace) window.location.replace(href);
    else window.location.assign(href);
    return;
  }
  void navigate(target, {
    replace,
    preventScrollReset: options?.scroll === false,
  });
}

export type AppRouter = {
  push: (href: string, options?: NavigateOptions) => void;
  replace: (href: string, options?: NavigateOptions) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => void;
};

/** 返回稳定的命令式路由对象。 */
export function useRouter(): AppRouter {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href, options) => navigateTo(navigate, href, false, options),
      replace: (href, options) => navigateTo(navigate, href, true, options),
      back: () => void navigate(-1),
      forward: () => void navigate(1),
      refresh: refreshRoutes,
      prefetch: () => undefined,
    }),
    [navigate]
  );
}

/** 当前路径（含语言前缀）。 */
export function usePathname(): string {
  return useLocation().pathname;
}

/** 当前查询参数（只读使用）。 */
export function useSearchParams(): URLSearchParams {
  return useRouterSearchParams()[0];
}

type RouteHandle = { catchAll?: string };

/** 当前路由参数；catch-all 段按原约定返回字符串数组。 */
export function useParams<
  T extends Record<string, string | string[] | undefined> = Record<
    string,
    string | string[] | undefined
  >,
>(): T {
  const params = useRouterParams();
  const matches = useMatches();
  return useMemo(() => {
    const result: Record<string, string | string[] | undefined> = { ...params };
    const catchAll = matches
      .map((match) => (match.handle as RouteHandle | undefined)?.catchAll)
      .findLast(Boolean);
    if (catchAll) {
      const splat = params["*"];
      delete result["*"];
      result[catchAll] = splat ? splat.split("/").filter(Boolean) : undefined;
    }
    return result as T;
  }, [params, matches]);
}
