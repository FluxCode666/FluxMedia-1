/**
 * 统一媒体上游请求。
 *
 * 职责：对 API/Adobe gateway 请求执行 DNS pin；允许管理员配置公网、私网与 HTTP
 * 上游，同时为上游派生的跨源地址提供公网限定请求。媒体下载逐跳解析重定向并限制
 * 真实响应字节。
 * 使用方：图片与视频上游适配器及持久化媒体管线。
 */
import {
  type DnsPinFetchOptions,
  fetchWithDnsPin,
  SsrfBlockedError,
} from "@repo/shared/security/dns-pin";

import {
  allowAnyMediaUpstreamAddress,
  parseMediaUpstreamUrl,
  resolveMediaUpstreamRedirect,
} from "./media-upstream-url";

const MAX_MEDIA_REDIRECTS = 3;
export const MEDIA_UPSTREAM_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_IMAGE_UPSTREAM_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** 上游请求允许的 fetch 风格输入；重定向始终由本模块手动处理。 */
export type MediaUpstreamFetchInit = Pick<
  DnsPinFetchOptions,
  "method" | "headers" | "body" | "timeoutMs" | "signal" | "maxResponseBytes"
>;

type MediaUpstreamDownloadInit = Pick<
  MediaUpstreamFetchInit,
  "signal" | "timeoutMs" | "maxResponseBytes"
>;

/** 把连接层 DNS 解析失败收敛为不回显目标主机的稳定错误。 */
function sanitizeMediaUpstreamFetchError(error: unknown): never {
  if (error instanceof SsrfBlockedError) {
    throw new Error("媒体上游域名无法解析");
  }
  throw error;
}

/** 执行一次 DNS pin 请求，并按调用方信任边界决定是否允许私网地址。 */
async function fetchMediaUpstreamWithPolicy(
  rawUrl: string,
  init: MediaUpstreamFetchInit,
  allowPrivateAddress: boolean
): Promise<Response> {
  const target = parseMediaUpstreamUrl(rawUrl);
  try {
    return await fetchWithDnsPin(target.toString(), {
      ...init,
      // 生图首个响应块通常超过通用 SSRF fetch 的 10 秒默认值；业务总时限仍由
      // 调用方的 AbortSignal 控制，这里只避免连接层过早截断正常媒体任务。
      timeoutMs: init.timeoutMs ?? MEDIA_UPSTREAM_TIMEOUT_MS,
      ...(allowPrivateAddress
        ? { allowBlockedAddress: allowAnyMediaUpstreamAddress }
        : {}),
    });
  } catch (error) {
    sanitizeMediaUpstreamFetchError(error);
  }
}

/**
 * 发起单跳媒体上游请求。
 *
 * @param rawUrl 管理员配置或上游响应中的 HTTP(S) URL。
 * @param init 显式 provider 请求头、正文、取消信号与响应大小上限。
 * @returns 不自动跟随重定向的 Response。
 * @throws URL 无效、DNS、超时或网络失败。
 */
export async function fetchMediaUpstream(
  rawUrl: string,
  init: MediaUpstreamFetchInit = {}
): Promise<Response> {
  return fetchMediaUpstreamWithPolicy(rawUrl, init, true);
}

/**
 * 请求一个上游派生的跨源地址，只允许 DNS pin 校验通过的公网目标。
 *
 * @param rawUrl - 上游响应提供的 HTTP(S) URL。
 * @param init - 显式请求头、正文、取消信号与响应大小上限。
 * @returns 不自动跟随重定向的 Response。
 * @throws 私网、保留地址、DNS、超时或网络失败时抛出脱敏错误。
 */
export async function fetchPublicMediaUpstream(
  rawUrl: string,
  init: MediaUpstreamFetchInit = {}
): Promise<Response> {
  return fetchMediaUpstreamWithPolicy(rawUrl, init, false);
}

/** 按信任源逐跳下载：可信同源可走私网，所有跨源跳转只允许公网目标。 */
async function fetchMediaUpstreamDownloadWithPolicy(
  rawUrl: string,
  init: MediaUpstreamDownloadInit,
  trustedOrigin?: string
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
  let current = parseMediaUpstreamUrl(rawUrl);
  for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop += 1) {
    const allowPrivateAddress =
      trustedOrigin === undefined || current.origin === trustedOrigin;
    const response = await (allowPrivateAddress
      ? fetchMediaUpstream
      : fetchPublicMediaUpstream)(current.toString(), {
      ...init,
      method: "GET",
      maxResponseBytes,
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("媒体上游重定向缺少 Location");
    }
    current = resolveMediaUpstreamRedirect(current, location);
  }
  throw new Error("媒体上游重定向次数过多");
}

/**
 * 下载上游媒体并逐跳解析重定向。
 *
 * 重定向请求不携带 API key、Cookie 或调用方 Authorization，避免跨主机泄露 provider
 * 凭据；真实响应体由连接层限制为 25 MiB。
 */
export async function fetchMediaUpstreamDownload(
  rawUrl: string,
  init: MediaUpstreamDownloadInit = {}
): Promise<Response> {
  return fetchMediaUpstreamDownloadWithPolicy(rawUrl, init);
}

/**
 * 下载 API 上游返回的产物，只把管理员配置的 Base URL 同源视为可访问私网。
 *
 * @param rawUrl - 上游返回的产物 URL。
 * @param trustedBaseUrl - 管理员配置并已验证的账号 Base URL。
 * @param init - 取消信号、超时与真实响应字节上限。
 * @returns 最终非重定向 Response。
 * @throws 跨源目标解析到私网/保留地址或任一下载边界失败时抛错。
 */
export async function fetchMediaUpstreamDownloadWithTrustedOrigin(
  rawUrl: string,
  trustedBaseUrl: string,
  init: MediaUpstreamDownloadInit = {}
): Promise<Response> {
  const trustedOrigin = parseMediaUpstreamUrl(trustedBaseUrl).origin;
  return fetchMediaUpstreamDownloadWithPolicy(rawUrl, init, trustedOrigin);
}
