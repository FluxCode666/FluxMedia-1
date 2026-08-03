/**
 * 文档 Base URL 的纯解析与占位符替换逻辑。
 *
 * 使用方：服务端请求适配器、公开接入文档和管理员 API 文档。关键依赖仅为标准
 * Headers/URL 接口，便于在 Vitest 中覆盖反向代理、开发端口和非法请求头边界。
 */
import { getSiteBaseUrl } from "@repo/shared/config";

/** 静态文档数据中的 Base URL 占位符，只允许在渲染前替换。 */
export const DOCUMENTATION_BASE_URL_PLACEHOLDER = "{{FLUXMEDIA_BASE_URL}}";

/** 文档来源解析只需要 Headers 的只读 get 契约。 */
export type DocumentationHeaderReader = Pick<Headers, "get">;

/** 从可能包含代理链的请求头中读取最靠近客户端的第一个非空值。 */
function getFirstHeaderValue(value: string | null): string | null {
  const firstValue = value?.split(",", 1)[0]?.trim();
  return firstValue || null;
}

/** 判断 hostname 是否为本地开发环境常见的明确回环地址。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;

  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;

  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

/**
 * 将协议与 Host authority 收敛为不带路径的 HTTP(S) origin。
 *
 * @param protocol - 已收敛为 http 或 https 的协议名。
 * @param authority - Host 或 X-Forwarded-Host 的单个 authority。
 * @returns 合法 origin；凭据、路径、查询、片段或非法 Host 返回 null。
 * @sideEffects 无。
 * @failure URL 解析异常被收窄为 null，调用方继续尝试下一个 Host 来源。
 */
function parseHttpOrigin(
  protocol: "http" | "https",
  authority: string
): string | null {
  if (!authority || authority.trim() !== authority) return null;

  try {
    const url = new URL(`${protocol}://${authority}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 校验配置回退地址并收敛为 origin。
 *
 * @param value - NEXT_PUBLIC_APP_URL 派生的站点 Base URL。
 * @returns 不带路径、查询、片段和尾斜杠的 HTTP(S) origin。
 * @sideEffects 无。
 * @failure 配置非法时抛出 TypeError，避免文档静默生成错误或危险地址。
 */
function parseFallbackOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("Documentation fallback Base URL must be an origin");
    }
    return url.origin;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Documentation fallback Base URL is invalid", {
      cause: error,
    });
  }
}

/**
 * 从当前请求头解析文档应展示的 Base URL。
 *
 * 生产 Nginx 会覆盖 X-Forwarded-Host/X-Forwarded-Proto，因此优先使用这组公网来源；
 * 直连开发服务器时使用 Host，并为明确回环地址选择 HTTP。所有请求头都先经 URL
 * 语法收窄，非法代理值会回退 Host，再回退站点配置。
 *
 * @param headers - 当前 Next.js 请求头的只读视图。
 * @param fallbackBaseUrl - 请求头不可用时使用的可信站点配置。
 * @returns 当前请求对应的 HTTP(S) origin，不带尾斜杠。
 * @sideEffects 缺省回退值只读访问公开站点配置。
 * @failure fallbackBaseUrl 非法时抛出 TypeError；非法请求头本身不会抛错。
 */
export function resolveDocumentationBaseUrl(
  headers: DocumentationHeaderReader,
  fallbackBaseUrl = getSiteBaseUrl()
): string {
  const fallbackOrigin = parseFallbackOrigin(fallbackBaseUrl);
  const forwardedProtocol = getFirstHeaderValue(
    headers.get("x-forwarded-proto")
  );
  const explicitProtocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : null;
  const authorities = [
    getFirstHeaderValue(headers.get("x-forwarded-host")),
    getFirstHeaderValue(headers.get("host")),
  ];

  for (const authority of authorities) {
    if (!authority) continue;

    const fallbackProtocol = fallbackOrigin.startsWith("https://")
      ? "https"
      : "http";
    const initiallyResolved = parseHttpOrigin(
      explicitProtocol ?? fallbackProtocol,
      authority
    );
    if (!initiallyResolved) continue;

    if (!explicitProtocol) {
      const hostname = new URL(initiallyResolved).hostname;
      if (isLoopbackHostname(hostname)) {
        return parseHttpOrigin("http", authority) ?? fallbackOrigin;
      }
    }
    return initiallyResolved;
  }

  return fallbackOrigin;
}

/**
 * 把静态文档示例中的 Base URL 占位符替换为当前请求 origin。
 *
 * @param value - 可能包含零个或多个文档 Base URL 占位符的文本。
 * @param baseUrl - 已由 resolveDocumentationBaseUrl 校验的当前 origin。
 * @returns 替换全部占位符后的新字符串；原文本不被修改。
 * @sideEffects 无。
 */
export function replaceDocumentationBaseUrl(
  value: string,
  baseUrl: string
): string {
  return value.replaceAll(DOCUMENTATION_BASE_URL_PLACEHOLDER, baseUrl);
}
