/**
 * Adobe IMS 鉴权（移植自 adobe2api core/refresh_mgr.py + token_mgr.py 的核心逻辑）。
 *
 * - cookie → access_token：POST adobeid-na1 的 IMS check/v6/token（form：client_id +
 *   guest_allowed + scope；headers 带 Cookie）→ 拿短期 access_token（IMS Bearer）。
 * - 账号信息：用 access_token 查 IMS profile/v1。
 * - 余额：查 firefly.adobe.io/v1/credits/balance。
 * 这些请求同样经传输层（生产走 Go TLS 旁路；主机白名单含 .adobe.com/.adobelogin.com/.adobe.io）。
 */

import { AdobeRequestError, AuthError, UpstreamTemporaryError } from "./errors";
import { ADOBE_WEB_APP_PROFILES, type AdobeFireflyWebApp } from "./profile";
import { accountIdFromToken, decodeJwtPayload } from "./signing";
import type { FireflyTransport, FireflyTransportResponse } from "./transport";

export const IMS_REFRESH_URL =
  "https://adobeid-na1.services.adobe.com/ims/check/v6/token?jslVersion=v2-v0.48.0-1-g1e322cb";

export const IMS_DEFAULT_SCOPE = ADOBE_WEB_APP_PROFILES.express.imsScope;
export const IMS_FIREFLY_DEFAULT_SCOPE =
  ADOBE_WEB_APP_PROFILES.firefly.imsScope;

export type AdobeAccountInfo = {
  displayName: string;
  email: string;
  userId: string;
};

export type RefreshResult = {
  accessToken: string;
  expiresIn: number | null;
  account: AdobeAccountInfo | null;
};

const MAX_ADOBE_AUTH_RESPONSE_BYTES = 256 * 1024;
const SENSITIVE_ACCOUNT_FIELD_PATTERN =
  /(?:authorization|cookie|password|secret)\s*[:=]|bearer\s+|(?:access|refresh|id)[_-]?token\s*[:=]|aux_sid\s*=/i;

/**
 * 清洗 Adobe Profile 的账号展示或身份字段。
 *
 * @param value 未信任的 Adobe 字段。
 * @param maxLength 最大字符数。
 * @param pattern 可选的完整形态约束。
 * @returns 有限且不含疑似凭据的字符串，否则返回空字符串。
 */
function safeAdobeAccountField(
  value: unknown,
  maxLength: number,
  pattern?: RegExp
): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().slice(0, maxLength);
  if (
    !normalized ||
    SENSITIVE_ACCOUNT_FIELD_PATTERN.test(normalized) ||
    (pattern && !pattern.test(normalized))
  ) {
    return "";
  }
  return normalized;
}

/**
 * 从响应 header 提取可信请求标识，不读取正文。
 *
 * @param response Adobe transport 响应。
 * @returns 有限 request ID；非法或疑似非标识符内容返回 undefined。
 */
function adobeRequestId(
  response: FireflyTransportResponse
): string | undefined {
  const value = String(
    response.headers["x-request-id"] ||
      response.headers["request-id"] ||
      response.headers["x-adobe-request-id"] ||
      ""
  ).trim();
  return value && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value)
    ? value
    : undefined;
}

/**
 * 在解析 JSON 前执行 Adobe 鉴权响应字节上限与对象形态校验。
 *
 * @param response transport 响应。
 * @returns 普通 JSON object；数组、空值、超限和无效 JSON 显式失败。
 */
async function readAdobeAuthJsonObject(
  response: FireflyTransportResponse
): Promise<Record<string, unknown>> {
  const requestId = adobeRequestId(response);
  const bytes = await response.bytes();
  if (bytes.byteLength > MAX_ADOBE_AUTH_RESPONSE_BYTES) {
    throw new UpstreamTemporaryError("Adobe response exceeded size limit", {
      statusCode: response.status,
      errorType: "status",
      ...(requestId ? { requestId } : {}),
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf-8")) as unknown;
  } catch {
    throw new AdobeRequestError("Adobe response is not valid json", {
      statusCode: response.status,
      errorType: "status",
      ...(requestId ? { requestId } : {}),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdobeRequestError("Adobe response has invalid shape", {
      statusCode: response.status,
      errorType: "status",
      ...(requestId ? { requestId } : {}),
    });
  }
  return value as Record<string, unknown>;
}

/**
 * 将 Adobe HTTP 失败映射为结构化且不含响应正文的错误。
 *
 * @param response Adobe transport 响应。
 * @param operation 安全的操作标识。
 * @returns 永不返回；401/403 为 AuthError，临时状态为 UpstreamTemporaryError。
 */
function throwAdobeStatusError(
  response: FireflyTransportResponse,
  operation: string
): never {
  const message = `${operation} failed: ${response.status}`;
  const requestId = adobeRequestId(response);
  const options = {
    statusCode: response.status,
    ...(requestId ? { requestId } : {}),
  };
  if (response.status === 401 || response.status === 403) {
    throw new AuthError(message, options);
  }
  if (
    response.status === 408 ||
    response.status === 429 ||
    response.status === 451 ||
    response.status >= 500
  ) {
    throw new UpstreamTemporaryError(message, {
      ...options,
      errorType: "status",
    });
  }
  throw new AdobeRequestError(message, { ...options, errorType: "status" });
}

/** 把多种 cookie 输入（字符串/数组/对象）归一为 "k=v; k=v" 串。移植 _cookie_string_from_input。 */
export function normalizeCookieString(input: unknown): string {
  if (typeof input === "string") {
    let text = input.trim();
    if (text.toLowerCase().startsWith("cookie:")) {
      text = text.slice(text.indexOf(":") + 1).trim();
    }
    // 管理后台允许直接粘贴导出扩展生成的 JSON。只读取其中的 cookie，
    // 避免把 headers 等不应作为 Cookie 转发的字段混入 IMS 请求。
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return normalizeCookieString(JSON.parse(text) as unknown);
      } catch {
        // 原始 Cookie 允许包含任意字符；不是 JSON 时保持既有字符串语义。
      }
    }
    return text;
  }
  let value: unknown = input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.cookies)) value = obj.cookies;
    else if (obj.cookie !== undefined) value = obj.cookie;
    else return "";
  }
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const pairs: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        const txt = item.trim();
        if (txt) pairs.push(txt);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const name = String(rec.name || "").trim();
      const val = String(rec.value || "").trim();
      if (!name) continue;
      pairs.push(`${name}=${val}`);
    }
    return pairs.join("; ");
  }
  return "";
}

function refreshFormBody(clientId: string, scope: string): string {
  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("guest_allowed", "true");
  form.set("scope", scope);
  return form.toString();
}

/** 用 cookie 换 access_token。移植 refresh_once 的 IMS 请求部分。 */
export async function refreshAccessTokenFromCookie(
  transport: FireflyTransport,
  cookieInput: unknown,
  opts?: {
    profile?: AdobeFireflyWebApp;
    scope?: string;
    signal?: AbortSignal;
    fetchAccount?: boolean;
  }
): Promise<RefreshResult> {
  const cookie = normalizeCookieString(cookieInput);
  if (!cookie) throw new Error("cookie is required");
  const profile = ADOBE_WEB_APP_PROFILES[opts?.profile ?? "express"];
  const scope = opts?.scope || profile.imsScope;

  const resp = await transport.request({
    method: "POST",
    url: IMS_REFRESH_URL,
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Cookie: cookie,
      Origin: profile.origin,
      Referer: profile.referer,
      "User-Agent": "Mozilla/5.0",
    },
    body: refreshFormBody(profile.imsClientId, scope),
    signal: opts?.signal,
    timeoutMs: 30_000,
    maxResponseBytes: MAX_ADOBE_AUTH_RESPONSE_BYTES,
  });

  if (resp.status !== 200) {
    throwAdobeStatusError(resp, "refresh request");
  }
  const data = await readAdobeAuthJsonObject(resp);
  const accessToken = String(data.access_token || "").trim();
  if (!accessToken) throw new Error("refresh response missing access_token");
  const tokenClientId = String(
    decodeJwtPayload(accessToken).client_id || ""
  ).trim();
  if (tokenClientId && tokenClientId !== profile.imsClientId) {
    throw new Error("refresh response token client_id mismatch");
  }

  let account: AdobeAccountInfo | null = null;
  if (opts?.fetchAccount !== false) {
    account = await fetchAccountInfo(
      transport,
      accessToken,
      opts?.signal
    ).catch(() => null);
  }

  const expiresInRaw = data.expires_in;
  const expiresIn =
    typeof expiresInRaw === "number"
      ? expiresInRaw
      : Number.isFinite(Number(expiresInRaw))
        ? Number(expiresInRaw)
        : null;

  return { accessToken, expiresIn, account };
}

/** 用 access_token 查账号信息。移植 _fetch_account_info。 */
export async function fetchAccountInfo(
  transport: FireflyTransport,
  accessToken: string,
  signal?: AbortSignal
): Promise<AdobeAccountInfo | null> {
  const token = String(accessToken || "").trim();
  if (!token) return null;
  const urls = [
    "https://ims-na1.adobelogin.com/ims/profile/v1",
    "https://adobeid-na1.services.adobe.com/ims/profile/v1",
  ];
  for (const url of urls) {
    let data: Record<string, unknown> | null = null;
    try {
      const resp = await transport.request({
        method: "GET",
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal,
        timeoutMs: 15_000,
        maxResponseBytes: MAX_ADOBE_AUTH_RESPONSE_BYTES,
      });
      if (resp.status !== 200) continue;
      data = await readAdobeAuthJsonObject(resp);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    const displayName = safeAdobeAccountField(
      data.displayName || data.name || data.fullName,
      256
    );
    const email = safeAdobeAccountField(
      data.email,
      320,
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    );
    const userId = safeAdobeAccountField(
      data.userId || data.authId,
      512,
      /^[A-Za-z0-9._:@/-]+$/
    );
    if (displayName || email || userId) {
      return { displayName, email, userId };
    }
  }
  return null;
}

export type AdobeCreditsBalance = {
  total: number | null;
  used: number | null;
  available: number | null;
  availableUntil: unknown;
};

/** 查 Firefly 余额。移植 _fetch_credits_balance。 */
export async function fetchCreditsBalance(
  transport: FireflyTransport,
  accessToken: string,
  signal?: AbortSignal
): Promise<AdobeCreditsBalance> {
  const token = String(accessToken || "").trim();
  if (!token) throw new Error("empty access token");
  const accountId = accountIdFromToken(token);
  if (!accountId) throw new Error("missing account id");

  const resp = await transport.request({
    method: "GET",
    url: "https://firefly.adobe.io/v1/credits/balance",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-key": "SunbreakWebUI1",
      "x-account-id": accountId,
      Origin: "https://new.express.adobe.com",
      Referer: "https://new.express.adobe.com/",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    signal,
    timeoutMs: 20_000,
    maxResponseBytes: MAX_ADOBE_AUTH_RESPONSE_BYTES,
  });
  if (resp.status !== 200) {
    throwAdobeStatusError(resp, "credits request");
  }
  const payload = await readAdobeAuthJsonObject(resp);
  const total = (payload?.total as Record<string, unknown>) || {};
  const quota = (total.quota as Record<string, unknown>) || {};
  return {
    total: (quota.total as number) ?? null,
    used: (quota.used as number) ?? null,
    available: (quota.available as number) ?? null,
    availableUntil: total.availableUntil ?? null,
  };
}
