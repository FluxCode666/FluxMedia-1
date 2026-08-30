/**
 * 媒体上游 URL 解析。
 *
 * 职责：为管理员配置的 API 与上游重定向提供统一的 HTTP(S)
 * URL 解析；不限制公网、私网、保留地址或协议是否启用 TLS。
 * 使用方：成员保存、运行时配置加载与媒体上游请求。
 */

/**
 * 解析媒体上游 URL。
 *
 * @param rawUrl 管理员配置或上游响应中的 URL。
 * @returns 可供 HTTP 客户端使用的标准 URL。
 * @throws URL 无法解析或不是 HTTP(S) 协议时抛出稳定错误。
 */
export function parseMediaUpstreamUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("媒体上游地址无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("媒体上游地址必须使用 HTTP 或 HTTPS");
  }
  return url;
}

/**
 * 解析媒体上游重定向。
 *
 * @param currentUrl 当前请求 URL。
 * @param location 上游 Location 值，可为相对 URL。
 * @returns 已解析的下一跳 HTTP(S) URL。
 * @throws Location 无效或解析后不是 HTTP(S) 协议时抛出稳定错误。
 */
export function resolveMediaUpstreamRedirect(
  currentUrl: string | URL,
  location: string
): URL {
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(location, currentUrl);
  } catch {
    throw new Error("媒体上游重定向地址无效");
  }
  return parseMediaUpstreamUrl(redirectUrl.toString());
}

/**
 * 允许连接层访问媒体上游解析出的任意地址。
 *
 * @returns 始终为 true；媒体后端地址由管理员配置，不再区分公网、私网或保留网段。
 */
export function allowAnyMediaUpstreamAddress(): boolean {
  return true;
}
