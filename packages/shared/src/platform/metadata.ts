/**
 * 页面元数据。
 *
 * 使用方：页面与布局导出的 metadata / generateMetadata。路由运行时按布局到页面的顺序
 * 合并后写入 document.head；首屏 SEO 标签由 Go 在返回 index.html 时注入，同样带
 * data-route-meta 标记，客户端接管后统一替换。
 */

type TitleValue =
  | string
  | { default?: string; template?: string; absolute?: string }
  | null;

type ImageValue = string | URL | { url: string | URL; width?: number; height?: number; alt?: string };

export type Metadata = {
  title?: TitleValue | undefined;
  description?: string | null | undefined;
  keywords?: string | readonly string[] | null | undefined;
  robots?: string | { index?: boolean; follow?: boolean; [key: string]: unknown } | null | undefined;
  metadataBase?: URL | null | undefined;
  openGraph?:
    | {
        title?: string | undefined;
        description?: string | undefined;
        url?: string | URL | undefined;
        type?: string | undefined;
        locale?: string | undefined;
        siteName?: string | undefined;
        images?: ImageValue | readonly ImageValue[] | undefined;
        [key: string]: unknown;
      }
    | null
    | undefined;
  twitter?:
    | {
        card?: string | undefined;
        title?: string | undefined;
        description?: string | undefined;
        images?: ImageValue | readonly ImageValue[] | undefined;
        [key: string]: unknown;
      }
    | null
    | undefined;
  alternates?:
    | { canonical?: string | URL | null | undefined; languages?: Record<string, string> | undefined }
    | null
    | undefined;
  [key: string]: unknown;
};

type ResolvedMetadata = {
  title: string | null;
  description: string | null;
  keywords: string | null;
  robots: string | null;
  openGraph: NonNullable<Metadata["openGraph"]> | null;
  twitter: NonNullable<Metadata["twitter"]> | null;
  alternates: NonNullable<Metadata["alternates"]> | null;
  metadataBase: URL | null;
};

/** 按 Next 语义合并元数据链：模板只作用于子段，absolute 忽略模板，其余字段后者覆盖前者。 */
export function resolveMetadata(chain: readonly Metadata[]): ResolvedMetadata {
  const resolved: ResolvedMetadata = {
    title: null,
    description: null,
    keywords: null,
    robots: null,
    openGraph: null,
    twitter: null,
    alternates: null,
    metadataBase: null,
  };
  let template: string | null = null;
  for (const metadata of chain) {
    const title = metadata.title;
    let nextTemplate: string | null = template;
    if (typeof title === "string") {
      resolved.title = template ? template.replace("%s", title) : title;
    } else if (title) {
      if (title.absolute) resolved.title = title.absolute;
      else if (title.default) resolved.title = title.default;
      if (title.template) nextTemplate = title.template;
    }
    template = nextTemplate;
    if (metadata.description !== undefined) resolved.description = metadata.description;
    if (metadata.keywords !== undefined) {
      resolved.keywords =
        typeof metadata.keywords === "string" || metadata.keywords === null
          ? metadata.keywords
          : metadata.keywords.join(", ");
    }
    if (metadata.robots !== undefined) {
      const robots = metadata.robots;
      resolved.robots =
        typeof robots === "string" || robots === null
          ? robots
          : [robots.index === false ? "noindex" : "index", robots.follow === false ? "nofollow" : "follow"].join(", ");
    }
    if (metadata.openGraph !== undefined) resolved.openGraph = metadata.openGraph;
    if (metadata.twitter !== undefined) resolved.twitter = metadata.twitter;
    if (metadata.alternates !== undefined) resolved.alternates = metadata.alternates;
    if (metadata.metadataBase !== undefined) resolved.metadataBase = metadata.metadataBase;
  }
  return resolved;
}

const MANAGED = "data-route-meta";

function absolute(value: string | URL, base: URL | null): string {
  try {
    return new URL(value, base ?? window.location.origin).toString();
  } catch {
    return String(value);
  }
}

function firstImage(images: ImageValue | readonly ImageValue[] | undefined): ImageValue | undefined {
  if (!images) return undefined;
  if (Array.isArray(images)) return images[0];
  return images as ImageValue;
}

function imageUrl(image: ImageValue): string | URL {
  return typeof image === "object" && "url" in image ? image.url : image;
}

/** 用合并后的元数据替换 document.head 中由路由管理的标签。 */
export function applyMetadata(chain: readonly Metadata[]): void {
  const resolved = resolveMetadata(chain);
  const head = document.head;
  for (const element of head.querySelectorAll(`[${MANAGED}]`)) element.remove();
  if (resolved.title) document.title = resolved.title;

  const meta = (attribute: "name" | "property", key: string, content: string | null | undefined) => {
    if (!content) return;
    const element = document.createElement("meta");
    element.setAttribute(attribute, key);
    element.setAttribute("content", content);
    element.setAttribute(MANAGED, "");
    head.appendChild(element);
  };
  const link = (rel: string, href: string, hreflang?: string) => {
    const element = document.createElement("link");
    element.rel = rel;
    element.href = href;
    if (hreflang) element.hreflang = hreflang;
    element.setAttribute(MANAGED, "");
    head.appendChild(element);
  };

  const base = resolved.metadataBase;
  meta("name", "description", resolved.description);
  meta("name", "keywords", resolved.keywords);
  meta("name", "robots", resolved.robots);

  const og = resolved.openGraph;
  if (og) {
    meta("property", "og:title", og.title ?? resolved.title);
    meta("property", "og:description", og.description ?? resolved.description);
    meta("property", "og:type", og.type);
    meta("property", "og:locale", og.locale);
    meta("property", "og:site_name", og.siteName);
    if (og.url) meta("property", "og:url", absolute(og.url, base));
    const image = firstImage(og.images);
    if (image) meta("property", "og:image", absolute(imageUrl(image), base));
  }
  const twitter = resolved.twitter;
  if (twitter) {
    meta("name", "twitter:card", twitter.card);
    meta("name", "twitter:title", twitter.title ?? resolved.title);
    meta("name", "twitter:description", twitter.description ?? resolved.description);
    const image = firstImage(twitter.images);
    if (image) meta("name", "twitter:image", absolute(imageUrl(image), base));
  }
  const alternates = resolved.alternates;
  if (alternates?.canonical) link("canonical", absolute(alternates.canonical, base));
  for (const [hreflang, href] of Object.entries(alternates?.languages ?? {})) {
    link("alternate", absolute(href, base), hreflang);
  }
}
