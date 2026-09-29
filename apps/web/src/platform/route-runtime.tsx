/**
 * App 目录约定的浏览器路由运行时。
 *
 * 使用方：routes.tsx 生成的 React Router 路由。页面与布局沿用原 App Router 的写法
 * （异步默认导出、params/searchParams Promise、metadata/generateMetadata、loading.tsx），
 * 这里负责在路由 loader 中执行它们：布局阻塞执行以便守卫跳转生效，存在 loading.tsx 的
 * 页面延迟执行并用骨架占位；redirect()/notFound() 信号转换为路由跳转与 404。
 */
import { invalidateServerSession } from "@repo/shared/auth/server";
import { type Metadata, applyMetadata } from "@repo/shared/platform/metadata";
import { setIntlState } from "@repo/shared/platform/intl";
import { NotFoundSignal, RedirectSignal, setLoadingUrl } from "@repo/shared/platform/navigation";
import {
  Children,
  type ComponentType,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  Suspense,
  cloneElement,
  createElement,
  use,
  useEffect,
} from "react";
import {
  type LoaderFunctionArgs,
  Navigate,
  Outlet,
  type Params,
  isRouteErrorResponse,
  redirect as routerRedirect,
  useLoaderData,
  useLocation,
  useMatches,
  useRouteError,
} from "react-router";
import type { AbstractIntlMessages } from "use-intl";

import { isSupportedLocale, routing } from "@/i18n/routing";

type SearchParamsRecord = Record<string, string | string[] | undefined>;
type SegmentParams = Record<string, string | string[] | undefined>;

type SegmentProps = {
  params: Promise<SegmentParams>;
  searchParams: Promise<SearchParamsRecord>;
};

// biome-ignore lint/suspicious/noExplicitAny: 页面与布局组件的 props 形状各不相同。
type SegmentComponent = ComponentType<any> | ((props: any) => Promise<ReactNode>);

export type SegmentModule = {
  default: SegmentComponent;
  metadata?: Metadata;
  generateMetadata?: (props: SegmentProps) => Promise<Metadata> | Metadata;
};

export type SegmentLoader = () => Promise<SegmentModule>;

type SegmentData = {
  node: ReactNode | Promise<ReactNode>;
  metadata?: Metadata | Promise<Metadata | undefined> | undefined;
};

// ============================================
// 国际化与会话
// ============================================

const messageModules = import.meta.glob<AbstractIntlMessages>("../../messages/*.json", {
  import: "default",
});
const messageCache = new Map<string, Promise<AbstractIntlMessages>>();

/** 加载语言消息并写入加载阶段的国际化状态；不支持的语言按 404 处理。 */
async function ensureIntl(locale: string | undefined): Promise<void> {
  if (!locale || !isSupportedLocale(locale)) throw new NotFoundSignal();
  let messages = messageCache.get(locale);
  if (!messages) {
    const load = messageModules[`../../messages/${locale}.json`];
    if (!load) throw new NotFoundSignal();
    messages = load();
    messageCache.set(locale, messages);
    messages.catch(() => messageCache.delete(locale));
  }
  setIntlState({ locale, messages: await messages });
}

const refreshedRequests = new WeakSet<AbortSignal>();

/**
 * 记录本次导航地址，并让会话缓存在每次导航（或刷新）中只失效一次。
 *
 * React Router 对同一次导航的所有 loader 传入同一个 request，因此并行 loader
 * 共享一次会话请求，而下一次导航会重新向 Go 确认登录态。
 */
function refreshSessionOnce(request: Request): void {
  setLoadingUrl(request.url);
  if (refreshedRequests.has(request.signal)) return;
  refreshedRequests.add(request.signal);
  invalidateServerSession();
}

// ============================================
// 参数
// ============================================

/** 把路由参数转换为原 App Router 形状；catch-all 段以字符串数组返回。 */
function toSegmentParams(params: Params, catchAll: string | undefined): SegmentParams {
  const result: SegmentParams = { ...params };
  if (catchAll) {
    const splat = params["*"];
    delete result["*"];
    result[catchAll] = splat ? splat.split("/").filter(Boolean).map(decodeURIComponent) : undefined;
  }
  return result;
}

function toSearchParams(request: Request): SearchParamsRecord {
  const result: SearchParamsRecord = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return result;
}

// ============================================
// 异步组件展开
// ============================================

function isAsyncComponent(type: unknown): type is (props: unknown) => Promise<ReactNode> {
  return typeof type === "function" && type.constructor.name === "AsyncFunction";
}

/** 在 Suspense 内部渲染延迟结果；promise 必须在多次渲染间保持稳定。 */
function Deferred({ promise }: { promise: Promise<ReactNode> }) {
  return use(promise);
}

function swallow<T>(promise: Promise<T>): Promise<T> {
  // 仅为避免导航离开后产生未处理拒绝告警，原 promise 仍按原样拒绝给使用方。
  promise.catch(() => undefined);
  return promise;
}

/**
 * 展开树中的异步组件（原服务端组件）。
 *
 * Suspense 外的异步组件就地 await，保证布局守卫与页面数据在渲染前就绪；
 * Suspense 内的异步组件转为 Deferred，由最近的 Suspense 显示 fallback。
 */
async function resolveNode(node: ReactNode, deferred = false): Promise<ReactNode> {
  if (Array.isArray(node)) {
    return Promise.all(node.map((child: ReactNode) => resolveNode(child, deferred)));
  }
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  if (isAsyncComponent(element.type)) {
    const rendered = element.type(element.props);
    if (deferred) {
      return createElement(Deferred, {
        key: element.key,
        promise: swallow(rendered.then((value) => resolveNode(value, true))),
      });
    }
    return createElement(Fragment, { key: element.key }, await resolveNode(await rendered));
  }
  const insideSuspense = deferred || element.type === Suspense;
  const props = element.props;
  const changes: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || isValidElement(value) || Array.isArray(value)) {
      if (typeof value === "function") continue;
      const next = await resolveNode(value as ReactNode, key === "children" && insideSuspense);
      if (next !== value) {
        changes[key] = next;
        changed = true;
      }
    }
  }
  if (!changed) return element;
  if ("children" in changes) {
    const { children, ...rest } = changes;
    return cloneElement(element, rest, ...Children.toArray(children as ReactNode));
  }
  return cloneElement(element, changes);
}

// ============================================
// Loader
// ============================================

/** 把跳转信号转换为路由跳转；其它错误原样抛给错误边界。 */
function rethrowAsRouteError(error: unknown): never {
  if (error instanceof RedirectSignal) throw routerRedirect(error.href);
  throw error;
}

function segmentMetadata(
  module: SegmentModule,
  props: SegmentProps
): SegmentData["metadata"] {
  if (module.generateMetadata) {
    return swallow(
      Promise.resolve()
        .then(() => module.generateMetadata?.(props))
        .catch(() => undefined)
    );
  }
  return module.metadata;
}

type LayoutOptions = { load: SegmentLoader; catchAll?: string | undefined };

/** 布局 loader：异步布局在导航完成前执行完毕，守卫跳转因此发生在渲染之前。 */
export function createLayoutLoader({ load, catchAll }: LayoutOptions) {
  return async ({ request, params }: LoaderFunctionArgs): Promise<SegmentData> => {
    try {
      refreshSessionOnce(request);
      await ensureIntl(params.locale);
      const module = await load();
      const props = {
        params: Promise.resolve(toSegmentParams(params, catchAll)),
        searchParams: Promise.resolve(toSearchParams(request)),
      };
      const Component = module.default;
      const outlet = createElement(Outlet);
      const node = isAsyncComponent(Component)
        ? await resolveNode(await Component({ params: props.params, children: outlet }))
        : createElement(Component, { params: props.params }, outlet);
      return { node, metadata: segmentMetadata(module, props) };
    } catch (error) {
      rethrowAsRouteError(error);
    }
  };
}

type PageOptions = LayoutOptions & { deferred: boolean };

/** 页面 loader：有 loading.tsx 时立即返回延迟结果，由骨架占位直到页面数据就绪。 */
export function createPageLoader({ load, catchAll, deferred }: PageOptions) {
  return async ({ request, params }: LoaderFunctionArgs): Promise<SegmentData> => {
    try {
      refreshSessionOnce(request);
      await ensureIntl(params.locale);
      const module = await load();
      const props = {
        params: Promise.resolve(toSegmentParams(params, catchAll)),
        searchParams: Promise.resolve(toSearchParams(request)),
      };
      const Component = module.default;
      const render = async () =>
        isAsyncComponent(Component)
          ? resolveNode(await Component(props))
          : createElement(Component, props);
      const metadata = segmentMetadata(module, props);
      if (deferred) return { node: swallow(render()), metadata };
      return { node: await render(), metadata };
    } catch (error) {
      rethrowAsRouteError(error);
    }
  };
}

/**
 * 布局路由的 shouldRevalidate：与 App Router 一致，布局只在自身参数变化或显式刷新时重新执行。
 *
 * @param paramNames - 布局路径及其祖先路径声明的参数名。
 */
export function createLayoutRevalidation(paramNames: readonly string[]) {
  return ({
    currentUrl,
    nextUrl,
    currentParams,
    nextParams,
    defaultShouldRevalidate,
  }: {
    currentUrl: URL;
    nextUrl: URL;
    currentParams: Params;
    nextParams: Params;
    defaultShouldRevalidate: boolean;
  }) => {
    if (!defaultShouldRevalidate) return false;
    if (currentUrl.pathname === nextUrl.pathname && currentUrl.search === nextUrl.search) return true;
    return paramNames.some((name) => currentParams[name] !== nextParams[name]);
  };
}

// ============================================
// 路由组件
// ============================================

/** 布局路由组件：渲染 loader 产出的布局树，树中的 Outlet 承载子路由。 */
export function LayoutRoute() {
  return (useLoaderData() as SegmentData).node;
}

/** 页面路由组件：延迟结果按路径分隔 Suspense，同路径的查询变化保留旧内容直到新数据就绪。 */
export function createPageRoute(Loading: ComponentType | null) {
  return function PageRoute() {
    const data = useLoaderData() as SegmentData;
    const { pathname } = useLocation();
    if (!(data.node instanceof Promise)) return data.node;
    return (
      <Suspense fallback={Loading ? <Loading /> : null} key={pathname}>
        <Deferred promise={data.node} />
      </Suspense>
    );
  };
}

/** 404 页面；可能在语言布局之外渲染，因此不依赖国际化上下文。 */
export function NotFoundPage() {
  const { pathname } = useLocation();
  const locale = pathname.split("/")[1];
  const isZh = locale === "zh";
  const home = `/${locale && isSupportedLocale(locale) ? locale : routing.defaultLocale}`;
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold">{isZh ? "页面不存在" : "This page could not be found"}</h1>
      <a className="text-sm text-primary underline-offset-4 hover:underline" href={home}>
        {isZh ? "返回首页" : "Back to home"}
      </a>
    </div>
  );
}

/** 路由错误边界：处理渲染期抛出的跳转与 404 信号，其余错误显示可重试的错误页。 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const { pathname } = useLocation();
  if (error instanceof RedirectSignal) return <Navigate replace to={error.href} />;
  if (error instanceof NotFoundSignal || (isRouteErrorResponse(error) && error.status === 404)) {
    return <NotFoundPage />;
  }
  const isZh = pathname.startsWith("/zh");
  if (import.meta.env.DEV) console.error(error);
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold">{isZh ? "页面加载失败" : "Something went wrong"}</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {isZh ? "请稍后重试；如果问题持续存在，请联系支持。" : "Please try again. Contact support if the problem persists."}
      </p>
      <button
        className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
        onClick={() => window.location.reload()}
        type="button"
      >
        {isZh ? "重新加载" : "Reload"}
      </button>
    </div>
  );
}

/** 合并当前匹配链的元数据并写入 document.head。 */
export function MetadataManager() {
  const matches = useMatches();
  useEffect(() => {
    let cancelled = false;
    const chain = matches.map((match) => (match.loaderData as SegmentData | undefined)?.metadata);
    void Promise.all(chain).then((resolved) => {
      if (cancelled) return;
      applyMetadata(resolved.filter((item): item is Metadata => Boolean(item)));
    });
    return () => {
      cancelled = true;
    };
  }, [matches]);
  return null;
}
