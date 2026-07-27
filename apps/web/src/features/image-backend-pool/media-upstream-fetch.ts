/**
 * 统一媒体上游的连接层安全请求。
 *
 * 职责：对 API/Adobe gateway 请求执行 HTTPS、凭据、DNS 与私网策略校验，并在实际
 * 连接时 pin 已校验地址；媒体下载逐跳复验重定向且限制真实响应字节。
 * 使用方：图片上游适配器与唯一图片持久化管线。
 */
import {
  type DnsPinFetchOptions,
  fetchWithDnsPin,
  SsrfBlockedError,
} from "@repo/shared/security/dns-pin";

import {
  assertSafeMediaUpstreamRedirect,
  assertSafeMediaUpstreamUrl,
  isMediaUpstreamBlockedAddressAllowed,
} from "./outbound-url-security";

const MAX_MEDIA_REDIRECTS = 3;
export const MEDIA_UPSTREAM_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_IMAGE_UPSTREAM_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** 上游安全请求允许的 fetch 风格输入；重定向始终由本模块手动处理。 */
export type MediaUpstreamFetchInit = Pick<
  DnsPinFetchOptions,
  "method" | "headers" | "body" | "timeoutMs" | "signal" | "maxResponseBytes"
>;

/** 把连接层 SSRF 拒绝收敛为不回显目标主机的稳定错误。 */
function sanitizeMediaUpstreamFetchError(error: unknown): never {
  if (error instanceof SsrfBlockedError) {
    throw new Error("媒体上游请求被网络安全策略阻止");
  }
  throw error;
}

/**
 * 发起单跳媒体上游请求。
 *
 * @param rawUrl 管理员配置或上游响应中的不可信 URL。
 * @param init 显式 provider 请求头、正文、取消信号与响应大小上限。
 * @returns 不自动跟随重定向的 Response。
 * @throws URL 策略、DNS pin、超时或网络失败。
 */
export async function fetchMediaUpstream(
  rawUrl: string,
  init: MediaUpstreamFetchInit = {}
): Promise<Response> {
  const target = await assertSafeMediaUpstreamUrl(rawUrl);
  try {
    return await fetchWithDnsPin(target.toString(), {
      ...init,
      // 生图首个响应块通常超过通用 SSRF fetch 的 10 秒默认值；业务总时限仍由
      // 调用方的 AbortSignal 控制，这里只避免连接层过早截断正常媒体任务。
      timeoutMs: init.timeoutMs ?? MEDIA_UPSTREAM_TIMEOUT_MS,
      allowBlockedAddress: isMediaUpstreamBlockedAddressAllowed,
    });
  } catch (error) {
    sanitizeMediaUpstreamFetchError(error);
  }
}

/**
 * 安全下载上游媒体并逐跳复验重定向。
 *
 * 重定向请求不携带 API key、Cookie 或调用方 Authorization，避免跨主机泄露 provider
 * 凭据；真实响应体由连接层限制为 25 MiB。
 */
export async function fetchMediaUpstreamDownload(
  rawUrl: string,
  init: Pick<
    MediaUpstreamFetchInit,
    "signal" | "timeoutMs" | "maxResponseBytes"
  > = {}
): Promise<Response> {
  const maxResponseBytes =
    init.maxResponseBytes ?? MAX_IMAGE_UPSTREAM_DOWNLOAD_BYTES;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0 ||
    maxResponseBytes > MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES
  ) {
    throw new Error("媒体上游响应大小上限无效");
  }
  let current = await assertSafeMediaUpstreamUrl(rawUrl);
  for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop += 1) {
    const response = await fetchMediaUpstream(current.toString(), {
      ...init,
      method: "GET",
      maxResponseBytes,
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("媒体上游重定向缺少 Location");
    }
    current = await assertSafeMediaUpstreamRedirect(current, location);
  }
  throw new Error("媒体上游重定向次数过多");
}
