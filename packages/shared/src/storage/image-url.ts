/**
 * 存储图像 URL 纯工具（客户端安全，零 Node 内置依赖）
 *
 * 从 ./signed-url 拆出的纯字符串/URL 处理函数，供客户端组件（缩略图改写、
 * URL 解析）与服务端共同使用。签名/验签等需要 node:crypto 与签名密钥的函数
 * 留在 ./signed-url（服务端专用）。
 *
 * WHY 独立成文件：客户端 import 任何含 node:crypto 的模块都会把整套
 * crypto-browserify polyfill（约 450KB raw / 130KB gzip）打进 authed 公共包。
 * 本模块必须保持不 import 任何 Node 内置模块；新增函数前先确认是纯函数。
 */

/** 不可能与合法 S3 bucket 同名的第一方头像读取逻辑别名。 */
export const PUBLIC_AVATAR_BUCKET_ALIAS = "_avatars";

export type StorageImageReference = {
  bucket: string;
  key: string;
};

/**
 * 不需要签名的公开桶名集合。
 * 头像资产所在 bucket 始终公开；它可以同时承载模型封面和品牌资产，但不能承载
 * generations 用户私有内容。
 */
const PUBLIC_BUCKETS = new Set([
  PUBLIC_AVATAR_BUCKET_ALIAS,
  process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME || "avatars",
]);

/**
 * 判断桶是否为公开桶（不需要签名验证）
 */
export function isPublicBucket(bucket: string): boolean {
  return PUBLIC_BUCKETS.has(bucket);
}

/**
 * 把已签名的站内存储图 URL 改写成"按路径段携带宽度"的缩略图 URL。
 *
 * WHY 用路径段而非 `?w=` 查询参数:线上 Cloudflare 对 `/api/storage/*` 的边缘缓存
 * 键忽略 query(含 w),导致所有 `?w=` 缩略图请求都命中并吐回被缓存的整张原图(几百
 * KB~1.5MB),把浏览器↔CF 的单条 HTTP/2 连接带宽占满、饿死同连接上的导航 RSC 请求,
 * 表现为"加载图片时点侧边栏没反应"。把宽度放进 bucket 之后的路径段
 * (`/api/storage/<bucket>/w<width>/<key>`)后:CF 按路径区分各宽度、且是全新路径形态,
 * 不会命中旧的原图缓存键 → 边缘真正缓存源站返回的小 webp。
 *
 * 签名仅覆盖 `bucket/key`,宽度段不参与签名(由读取路由在验签前剥离),故 sig/exp 不变。
 * 仅改写本站 `/api/storage/` 相对 URL;其它(第三方/绝对/空)原样返回。
 *
 * @param signedUrl - generateSignedImageUrl 产出的 `/api/storage/<bucket>/<key>?sig=&exp=`
 * @param width - 目标宽度像素(正整数);非法或非本站 URL 时原样返回入参
 */
export function buildStorageThumbnailUrl(
  signedUrl: string | null | undefined,
  width: number
): string | null | undefined {
  if (!signedUrl || !signedUrl.startsWith("/api/storage/")) {
    return signedUrl;
  }
  if (!Number.isInteger(width) || width <= 0) {
    return signedUrl;
  }
  const prefix = "/api/storage/";
  const qIndex = signedUrl.indexOf("?");
  const pathname = qIndex === -1 ? signedUrl : signedUrl.slice(0, qIndex);
  const query = qIndex === -1 ? "" : signedUrl.slice(qIndex);
  const rest = pathname.slice(prefix.length); // <bucket>/<...key>
  const slash = rest.indexOf("/");
  // 必须同时有 bucket 段与至少一个 key 段,否则不是可改写的图片 URL。
  if (slash <= 0 || slash >= rest.length - 1) {
    return signedUrl;
  }
  const bucket = rest.slice(0, slash);
  const keyPath = rest.slice(slash + 1);
  return `${prefix}${bucket}/w${width}/${keyPath}${query}`;
}

/**
 * 解析本站 /api/storage/<bucket>/<key> 图片 URL。
 *
 * 只接受相对 URL，或与 publicBaseUrl 同源的绝对 URL；第三方对象存储/预签名
 * URL 不会被误判。返回的 key 已解码并做基础路径安全校验。
 */
export function parseStorageImageUrl(
  imageUrl: string | null | undefined,
  publicBaseUrl?: string | null
): StorageImageReference | null {
  const raw = imageUrl?.trim();
  if (!raw) return null;

  try {
    const base = publicBaseUrl?.trim() || "http://localhost";
    const parsed = new URL(raw, base);
    const isRelativeStorageUrl = raw.startsWith("/api/storage/");
    const isOwnStorageUrl =
      Boolean(publicBaseUrl?.trim()) &&
      parsed.origin === new URL(base).origin &&
      parsed.pathname.startsWith("/api/storage/");

    if (!(isRelativeStorageUrl || isOwnStorageUrl)) return null;

    const segments = parsed.pathname.split("/").filter(Boolean);
    const storageIndex = segments.indexOf("storage");
    const bucket = segments[storageIndex + 1];
    const keySegments = segments.slice(storageIndex + 2);
    if (storageIndex < 0 || !bucket || keySegments.length === 0) return null;

    const key = keySegments
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    if (
      !key ||
      key.startsWith("/") ||
      key.includes("\\") ||
      key.includes("\0") ||
      key.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return null;
    }

    return {
      bucket: decodeURIComponent(bucket),
      key,
    };
  } catch {
    return null;
  }
}
