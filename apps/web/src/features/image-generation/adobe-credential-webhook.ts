/**
 * Adobe 凭据健康 Webhook 的安全投递边界。
 *
 * 职责：校验公网 HTTPS 目标、在连接层固定 DNS、拒绝重定向、生成版本化
 * HMAC-SHA256 签名并把上游响应收敛为有限错误码。使用方是通知 outbox worker；
 * 本文件不读取数据库、不记录请求正文，也不把响应正文返回给调用方。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  fetchWithDnsPin,
  SsrfBlockedError,
} from "@repo/shared/security/dns-pin";

import {
  assertPublicCallbackUrl,
  readResponseBytesWithLimit,
  SafeImageFetchError,
} from "../external-api/safe-image-fetch";

export const ADOBE_CREDENTIAL_WEBHOOK_VERSION = "v1";
export const ADOBE_CREDENTIAL_WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
export const ADOBE_CREDENTIAL_WEBHOOK_TIMEOUT_MS = 10_000;

type WebhookFailureCode =
  | "invalid_configuration"
  | "ssrf_blocked"
  | "redirect_rejected"
  | "request_timeout"
  | "network_error"
  | "rate_limited"
  | "upstream_temporary"
  | "request_rejected"
  | "response_too_large";

export class AdobeCredentialWebhookError extends Error {
  readonly code: WebhookFailureCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: WebhookFailureCode,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number;
      requestId?: string;
    } = {}
  ) {
    super(message);
    this.name = "AdobeCredentialWebhookError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }
}

/** Webhook 投递所需的不可变安全输入。 */
export type AdobeCredentialWebhookRequest = {
  url: string;
  secret: string;
  eventId: string;
  deliveryId: string;
  payload: Record<string, unknown>;
  now?: Date;
  signal?: AbortSignal;
};

/** Webhook 投递成功后的有限响应摘要。 */
export type AdobeCredentialWebhookResult = {
  statusCode: number;
  requestId?: string;
};

function assertSafeIdentifier(value: string, name: string): void {
  if (
    !value ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new AdobeCredentialWebhookError(
      "invalid_configuration",
      `${name} is invalid`
    );
  }
}

/**
 * 校验部署级 Webhook 密钥强度。
 *
 * @param secret 环境变量中的密钥，不会被返回或写入日志。
 * @returns 可用于 HMAC 的密钥；弱密钥直接拒绝。
 */
export function assertAdobeCredentialWebhookSecret(secret: string): string {
  const normalized = secret.trim();
  if (Buffer.byteLength(normalized, "utf8") < 32) {
    throw new AdobeCredentialWebhookError(
      "invalid_configuration",
      "Adobe credential Webhook secret is not configured"
    );
  }
  return normalized;
}

/**
 * 计算不可逆密钥指纹，供 outbox 配置 revision 使用。
 *
 * @param secret HMAC 密钥。
 * @returns 十六进制 SHA-256 指纹；不返回密钥本身。
 */
export function adobeCredentialWebhookSecretFingerprint(
  secret: string
): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * 构造稳定 JSON 字节。调用方传入的 payload 已由通知层按固定字段构造。
 *
 * @param payload 脱敏通知 payload。
 * @returns UTF-8 JSON 字节。
 */
export function serializeAdobeCredentialWebhookPayload(
  payload: Record<string, unknown>
): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

/**
 * 计算 Webhook 签名覆盖的无歧义 canonical 字符串。
 *
 * @param input 协议版本、事件 ID、投递 ID、UTC 时间戳和正文。
 * @returns 待签名 UTF-8 字节。
 */
export function buildAdobeCredentialWebhookSigningInput(input: {
  version: string;
  eventId: string;
  deliveryId: string;
  timestamp: string;
  body: string;
}): string {
  return [
    input.version,
    input.eventId,
    input.deliveryId,
    input.timestamp,
    input.body,
  ].join("\n");
}

/**
 * 生成版本化 HMAC-SHA256 签名头。
 *
 * @param input 签名字段和原始正文。
 * @param secret HMAC 密钥。
 * @returns `v1=sha256=<hex>` 格式签名。
 */
export function signAdobeCredentialWebhook(input: {
  version: string;
  eventId: string;
  deliveryId: string;
  timestamp: string;
  body: string;
  secret: string;
}): string {
  const canonical = buildAdobeCredentialWebhookSigningInput(input);
  const digest = createHmac("sha256", input.secret)
    .update(canonical, "utf8")
    .digest("hex");
  return `${input.version}=sha256=${digest}`;
}

/**
 * 供接收方或回归测试验证签名；比较使用恒定时间算法。
 *
 * @param input 同 signAdobeCredentialWebhook 的公开字段。
 * @param signature 请求头中的签名。
 * @returns 版本、字段、正文和密钥均匹配时为 true。
 */
export function verifyAdobeCredentialWebhookSignature(input: {
  version: string;
  eventId: string;
  deliveryId: string;
  timestamp: string;
  body: string;
  secret: string;
  signature: string;
}): boolean {
  const expected = signAdobeCredentialWebhook(input);
  const received = input.signature.trim();
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

/** 解析 Retry-After 为不超过 15 分钟的毫秒数。 */
export function parseAdobeCredentialWebhookRetryAfter(
  value: string | null,
  now = new Date()
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(15 * 60_000, Math.round(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(15 * 60_000, Math.max(0, date - now.getTime()));
}

/**
 * 将 HTTP 响应映射为投递结果；3xx 明确视为配置/请求错误而非自动跟随。
 *
 * @param response Webhook 响应。
 * @param now 当前时间，用于解析 Retry-After。
 * @returns 成功摘要；非 2xx 抛出可重试或最终失败错误。
 */
export async function classifyAdobeCredentialWebhookResponse(
  response: Response,
  now = new Date()
): Promise<AdobeCredentialWebhookResult> {
  const requestIdValue = response.headers.get("x-request-id");
  const requestId =
    requestIdValue && /^[A-Za-z0-9._:-]{1,256}$/.test(requestIdValue.trim())
      ? requestIdValue.trim()
      : undefined;
  if (response.status >= 200 && response.status <= 299) {
    if (response.body) {
      await readResponseBytesWithLimit(
        response,
        ADOBE_CREDENTIAL_WEBHOOK_MAX_RESPONSE_BYTES,
        () => {
          throw new AdobeCredentialWebhookError(
            "response_too_large",
            "Webhook response exceeded size limit"
          );
        }
      );
    }
    return { statusCode: response.status, ...(requestId ? { requestId } : {}) };
  }

  const retryAfterMs = parseAdobeCredentialWebhookRetryAfter(
    response.headers.get("retry-after"),
    now
  );
  if (response.status >= 300 && response.status <= 399) {
    await response.body?.cancel().catch(() => undefined);
    throw new AdobeCredentialWebhookError(
      "redirect_rejected",
      "Webhook redirects are not allowed"
    );
  }
  if (
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429
  ) {
    throw new AdobeCredentialWebhookError(
      "rate_limited",
      "Webhook request was rate limited",
      {
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(requestId ? { requestId } : {}),
      }
    );
  }
  if (response.status >= 500 && response.status <= 599) {
    throw new AdobeCredentialWebhookError(
      "upstream_temporary",
      "Webhook service is temporarily unavailable",
      {
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(requestId ? { requestId } : {}),
      }
    );
  }
  throw new AdobeCredentialWebhookError(
    "request_rejected",
    "Webhook request was rejected",
    {
      ...(requestId ? { requestId } : {}),
    }
  );
}

/**
 * 投递一次 Adobe 凭据事件。
 *
 * @param input 不含 Cookie/Token 的事件正文、稳定 ID 和部署级密钥。
 * @returns 公网接收方的有限状态摘要。
 * @throws AdobeCredentialWebhookError 对 SSRF、网络、超时、重定向和 HTTP 错误分类。
 * @sideEffects 向唯一配置地址发送一次 POST；强制 DNS pin，禁止重定向。
 */
export async function deliverAdobeCredentialWebhook(
  input: AdobeCredentialWebhookRequest
): Promise<AdobeCredentialWebhookResult> {
  assertSafeIdentifier(input.eventId, "eventId");
  assertSafeIdentifier(input.deliveryId, "deliveryId");
  const secret = assertAdobeCredentialWebhookSecret(input.secret);
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new AdobeCredentialWebhookError(
      "invalid_configuration",
      "Webhook URL is invalid"
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new AdobeCredentialWebhookError(
      "invalid_configuration",
      "Webhook URL must be a public HTTPS URL without credentials"
    );
  }
  try {
    await assertPublicCallbackUrl(parsed.href);
  } catch (error) {
    if (
      error instanceof SafeImageFetchError ||
      error instanceof SsrfBlockedError
    ) {
      throw new AdobeCredentialWebhookError(
        "ssrf_blocked",
        "Webhook target is not public"
      );
    }
    throw new AdobeCredentialWebhookError(
      "invalid_configuration",
      "Webhook DNS validation failed"
    );
  }

  const now = input.now ?? new Date();
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const body = serializeAdobeCredentialWebhookPayload(input.payload);
  const signature = signAdobeCredentialWebhook({
    version: ADOBE_CREDENTIAL_WEBHOOK_VERSION,
    eventId: input.eventId,
    deliveryId: input.deliveryId,
    timestamp,
    body: body.toString("utf8"),
    secret,
  });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    ADOBE_CREDENTIAL_WEBHOOK_TIMEOUT_MS
  );
  const onAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    let response: Response;
    try {
      response = await fetchWithDnsPin(parsed.href, {
        method: "POST",
        timeoutMs: ADOBE_CREDENTIAL_WEBHOOK_TIMEOUT_MS,
        signal: controller.signal,
        maxResponseBytes: ADOBE_CREDENTIAL_WEBHOOK_MAX_RESPONSE_BYTES,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-FluxMedia-Webhook-Version": ADOBE_CREDENTIAL_WEBHOOK_VERSION,
          "X-FluxMedia-Event-Id": input.eventId,
          "X-FluxMedia-Delivery-Id": input.deliveryId,
          "X-FluxMedia-Timestamp": timestamp,
          "X-FluxMedia-Signature": signature,
          "Idempotency-Key": `adobe-credential:${input.deliveryId}`,
        },
        body,
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && /timed out|aborted/i.test(error.message))
      ) {
        throw new AdobeCredentialWebhookError(
          "request_timeout",
          "Webhook request timed out",
          {
            retryable: true,
          }
        );
      }
      if (error instanceof SsrfBlockedError) {
        throw new AdobeCredentialWebhookError(
          "ssrf_blocked",
          "Webhook target is not public"
        );
      }
      throw new AdobeCredentialWebhookError(
        "network_error",
        "Webhook network request failed",
        {
          retryable: true,
        }
      );
    }
    return await classifyAdobeCredentialWebhookResponse(response, now);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
