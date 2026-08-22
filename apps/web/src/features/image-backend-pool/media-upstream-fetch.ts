/**
 * 统一媒体上游请求。
 *
 * 职责：对 API/Adobe gateway 请求执行 DNS pin；当前运行策略允许所有解析地址，
 * 包括私网与保留网段。媒体下载仍逐跳解析重定向并限制真实响应字节。
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

/** 执行一次 DNS pin 请求；当前策略不限制解析出的地址类别。 */
async function fetchMediaUpstreamWithPolicy(
  rawUrl: string,
  init: MediaUpstreamFetchInit
): Promise<Response> {
  const target = parseMediaUpstreamUrl(rawUrl);
  try {
    return await fetchWithDnsPin(target.toString(), {
      ...init,
      // 生图首个响应块通常超过通用 SSRF fetch 的 10 秒默认值；业务总时限仍由
      // 调用方的 AbortSignal 控制，这里只避免连接层过早截断正常媒体任务。
      timeoutMs: init.timeoutMs ?? MEDIA_UPSTREAM_TIMEOUT_MS,
      // 当前后端要求所有上游域名均可访问，包括供应商返回的私网/保留网段地址。
      // DNS pin 仍保留，用于固定实际连接地址；地址分类拦截由显式策略关闭。
      allowBlockedAddress: allowAnyMediaUpstreamAddress,
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
  return fetchMediaUpstreamWithPolicy(rawUrl, init);
}

/**
 * 请求一个上游派生的跨源地址。
 *
 * @param rawUrl - 上游响应提供的 HTTP(S) URL。
 * @param init - 显式请求头、正文、取消信号与响应大小上限。
 * @returns 不自动跟随重定向的 Response。
 * @throws DNS、超时或网络失败时抛出脱敏错误。
 */
export async function fetchPublicMediaUpstream(
  rawUrl: string,
  init: MediaUpstreamFetchInit = {}
): Promise<Response> {
  return fetchMediaUpstreamWithPolicy(rawUrl, init);
}

/** 逐跳下载媒体；当前策略允许所有重定向目标地址。 */
async function fetchMediaUpstreamDownloadWithPolicy(
  rawUrl: string,
  init: MediaUpstreamDownloadInit
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
 * 下载 API 上游返回的产物；当前策略允许所有域名和解析地址。
 *
 * @param rawUrl - 上游返回的产物 URL。
 * @param trustedBaseUrl - 管理员配置并已验证的账号 Base URL。
 * @param init - 取消信号、超时与真实响应字节上限。
 * @returns 最终非重定向 Response。
 * @throws URL 无效、DNS、超时、网络或任一下载边界失败时抛错。
 */
export async function fetchMediaUpstreamDownloadWithTrustedOrigin(
  rawUrl: string,
  trustedBaseUrl: string,
  init: MediaUpstreamDownloadInit = {}
): Promise<Response> {
  // 仍解析管理员 Base URL，确保持久化的供应商配置是合法 HTTP(S)，但当前运行策略
  // 不再以它限制成品 URL 的域名或解析地址。
  parseMediaUpstreamUrl(trustedBaseUrl);
  return fetchMediaUpstreamDownloadWithPolicy(rawUrl, init);
}
