/**
 * 站内链接组件。
 *
 * 使用方：替代原 next/link。站内地址交给 React Router 做客户端跳转；外链、下载、
 * 新窗口与锚点链接保持原生 <a> 行为。
 */
import { type AnchorHTMLAttributes, createContext, forwardRef, useContext, useMemo } from "react";
import { Link as RouterLink, useNavigation } from "react-router";
import { toRouterHref } from "./navigation";

type QueryValue = string | number | boolean | null | undefined;

export type UrlObject = {
  pathname?: string | null;
  query?: Record<string, QueryValue | readonly QueryValue[]> | null;
  hash?: string | null;
};

export type Href = string | UrlObject;

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: Href;
  replace?: boolean;
  scroll?: boolean;
  prefetch?: boolean | null;
};

/** 把 Next 风格的 href 对象格式化为字符串地址。 */
export function formatHref(href: Href): string {
  if (typeof href === "string") return href;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(href.query ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== null && item !== undefined) search.append(key, String(item));
    }
  }
  const query = search.toString();
  const hash = href.hash ? (href.hash.startsWith("#") ? href.hash : `#${href.hash}`) : "";
  return `${href.pathname ?? ""}${query ? `?${query}` : ""}${hash}`;
}

const LinkStatusContext = createContext<{ pending: boolean }>({ pending: false });

/** 在 Link 子树内读取该链接目标是否正在加载。 */
export function useLinkStatus(): { pending: boolean } {
  return useContext(LinkStatusContext);
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, replace, scroll, prefetch: _prefetch, children, ...rest },
  ref
) {
  const url = formatHref(href);
  const target = toRouterHref(url);
  const navigation = useNavigation();
  const targetPath = target?.split(/[?#]/u)[0];
  const pending =
    navigation.state === "loading" && !!targetPath && navigation.location?.pathname === targetPath;
  const status = useMemo(() => ({ pending }), [pending]);
  if (
    target === null ||
    url.startsWith("#") ||
    /^(mailto|tel|sms|blob|data):/iu.test(url) ||
    rest.download !== undefined ||
    (rest.target !== undefined && rest.target !== "_self")
  ) {
    return (
      <a ref={ref} href={url} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <LinkStatusContext.Provider value={status}>
      <RouterLink
        ref={ref}
        to={target}
        replace={replace ?? false}
        preventScrollReset={scroll === false}
        {...rest}
      >
        {children}
      </RouterLink>
    </LinkStatusContext.Provider>
  );
});

export default Link;
