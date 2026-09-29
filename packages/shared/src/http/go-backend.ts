/**
 * 浏览器到 Go backend 的同源 JSON 请求边界。
 *
 * 使用方：页面加载函数、Action 与客户端组件。SPA 与 Go 同源部署，请求自动携带
 * HttpOnly 会话 Cookie；Go 负责全部鉴权，这里只统一 JSON 头与结构化错误。
 */

/** Go 端点返回的结构化失败；保留 HTTP 状态与稳定错误码供调用方分支。 */
export class GoBackendHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "GoBackendHttpError";
  }
}

type GoErrorPayload = {
  error?: { message?: string; code?: string } | string;
  message?: string;
} | null;

/** 读取失败响应中的安全错误文案；非 JSON 响应回退为状态码描述。 */
async function toHttpError(response: Response): Promise<GoBackendHttpError> {
  const payload = (await response.json().catch(() => null)) as GoErrorPayload;
  const error = payload?.error;
  const message =
    (typeof error === "object" ? error?.message : error) ||
    payload?.message ||
    `Go backend request failed (${response.status})`;
  const code = typeof error === "object" ? error?.code : undefined;
  return new GoBackendHttpError(message, response.status, code);
}

/** 发起同源 Go 请求并在非 2xx 时抛出 GoBackendHttpError；保留原始响应供流式读取。 */
export async function requestGoBackendResponse(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (
    init.body !== undefined &&
    init.body !== null &&
    typeof init.body === "string" &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await toHttpError(response);
  return response;
}

/** 发起同源 Go 请求并解析 JSON 响应体；空响应体返回 null。 */
export async function requestGoBackendJson<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await requestGoBackendResponse(path, init);
  return (await response.json().catch(() => null)) as T;
}

/** 过渡期 Action 适配层尚未建模的 Go 响应体；调用方按需读取字段。 */
// biome-ignore lint/suspicious/noExplicitAny: 旧 Action 返回值直接透传给页面，类型待逐个端点收窄。
export type UntypedGoBackendJson = any;
