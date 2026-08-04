/**
 * Firefly 直连的 HTTP 传输抽象。
 *
 * Adobe API 使用 Go 旁路代理 `services/media-upstream-proxy` 提供浏览器 TLS 指纹；
 * Node 原生 fetch 只用于产物下载。代理是无会话状态的单请求中转。
 *
 * 传输层提供两种实现：
 * - ProxyFireflyTransport：POST {proxyUrl}/request，body `{method, targetUrl,
 *   headers, headerOrder, bodyBase64}` → `{status, headers, bodyBase64}`（带 TLS 伪装）。
 * - FetchFireflyTransport：原生 fetch（无 TLS 伪装，用于产物下载/本地联调/未配代理回落）。
 */

import { UpstreamTemporaryError } from "./errors";

export type FireflyTransportRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer | Uint8Array | string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
};

export type FireflyTransportResponse = {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  bytes(): Promise<Buffer>;
};

export interface FireflyTransport {
  request(req: FireflyTransportRequest): Promise<FireflyTransportResponse>;
}

function buildResponse(
  status: number,
  headers: Record<string, string>,
  bytesPromise: () => Promise<Buffer>
): FireflyTransportResponse {
  let cached: Buffer | null = null;
  const readBytes = async (): Promise<Buffer> => {
    if (cached === null) cached = await bytesPromise();
    return cached;
  };
  return {
    status,
    headers,
    bytes: readBytes,
    text: async () => (await readBytes()).toString("utf-8"),
    json: async () => JSON.parse((await readBytes()).toString("utf-8")),
  };
}

function encodeBodyBase64(
  body: Buffer | Uint8Array | string | undefined
): string {
  if (body === undefined) return "";
  if (typeof body === "string")
    return Buffer.from(body, "utf-8").toString("base64");
  return Buffer.from(body).toString("base64");
}

/** 默认 fetch 传输（无 TLS 伪装）。 */
export class FetchFireflyTransport implements FireflyTransport {
  async request(
    req: FireflyTransportRequest
  ): Promise<FireflyTransportResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (req.timeoutMs && req.timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), req.timeoutMs);
    }
    const onAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }
    const release = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (req.signal) req.signal.removeEventListener("abort", onAbort);
    };
    try {
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        redirect: "manual",
        signal: controller.signal,
      };
      if (req.body !== undefined) init.body = req.body as BodyInit;
      const resp = await fetch(req.url, init);
      const headers: Record<string, string> = {};
      resp.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return buildResponse(resp.status, headers, async () => {
        try {
          return await readFetchResponseBytes(resp, req.maxResponseBytes);
        } finally {
          release();
        }
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

type ProxyResponsePayload = {
  status: number;
  headers?: Record<string, string[]>;
  bodyBase64?: string;
};

const MAX_PROXY_ENVELOPE_BYTES = 64 * 1024 * 1024;

/**
 * 在分配完整响应前按字节上限读取 fetch body。
 *
 * @param response 原生 fetch 响应。
 * @param maxBytes 可选上限；未提供时保留既有完整读取行为。
 * @returns 响应字节；超过上限抛出不含正文的错误。
 */
async function readFetchResponseBytes(
  response: Response,
  maxBytes?: number
): Promise<Buffer> {
  if (!maxBytes) return Buffer.from(await response.arrayBuffer());
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new UpstreamTemporaryError("Adobe response exceeded size limit", {
      statusCode: response.status,
      errorType: "status",
    });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new UpstreamTemporaryError("Adobe response exceeded size limit", {
          statusCode: response.status,
          errorType: "status",
        });
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes
  );
}

/**
 * 校验旁路代理的严格响应信封。
 *
 * @param value 未信任的 JSON 值。
 * @param maxBodyBytes 调用方允许的 Adobe 正文字节上限。
 * @returns 收窄后的信封；非法状态、header 或 base64 形态 fail-closed。
 */
function parseProxyResponsePayload(
  value: unknown,
  maxBodyBytes?: number
): ProxyResponsePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UpstreamTemporaryError("Firefly proxy response is invalid", {
      errorType: "proxy",
    });
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== "number" ||
    !Number.isInteger(record.status) ||
    record.status < 100 ||
    record.status > 599
  ) {
    throw new UpstreamTemporaryError("Firefly proxy response is invalid", {
      errorType: "proxy",
    });
  }
  const headers: Record<string, string[]> = {};
  if (record.headers !== undefined) {
    if (
      !record.headers ||
      typeof record.headers !== "object" ||
      Array.isArray(record.headers)
    ) {
      throw new UpstreamTemporaryError("Firefly proxy response is invalid", {
        errorType: "proxy",
      });
    }
    for (const [key, values] of Object.entries(
      record.headers as Record<string, unknown>
    )) {
      if (
        key.length > 256 ||
        !Array.isArray(values) ||
        values.some((item) => typeof item !== "string" || item.length > 8192)
      ) {
        throw new UpstreamTemporaryError("Firefly proxy response is invalid", {
          errorType: "proxy",
        });
      }
      headers[key] = values;
    }
  }
  const bodyBase64 = record.bodyBase64;
  if (
    bodyBase64 !== undefined &&
    (typeof bodyBase64 !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(bodyBase64))
  ) {
    throw new UpstreamTemporaryError("Firefly proxy response is invalid", {
      errorType: "proxy",
    });
  }
  if (
    maxBodyBytes &&
    typeof bodyBase64 === "string" &&
    Math.floor((bodyBase64.length * 3) / 4) > maxBodyBytes
  ) {
    throw new UpstreamTemporaryError("Adobe response exceeded size limit", {
      statusCode: record.status,
      errorType: "status",
    });
  }
  return {
    status: record.status,
    headers,
    ...(typeof bodyBase64 === "string" ? { bodyBase64 } : {}),
  };
}

/** Go 媒体上游旁路代理传输（TLS 伪装）。 */
export class ProxyFireflyTransport implements FireflyTransport {
  constructor(
    private readonly opts: {
      proxyUrl: string;
      secret?: string;
    }
  ) {}

  async request(
    req: FireflyTransportRequest
  ): Promise<FireflyTransportResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (req.timeoutMs && req.timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), req.timeoutMs);
    }
    const onAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }
    const proxyUrl = this.opts.proxyUrl.replace(/\/+$/, "");
    try {
      const resp = await fetch(`${proxyUrl}/request`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(this.opts.secret ? { "X-Proxy-Secret": this.opts.secret } : {}),
        },
        body: JSON.stringify({
          method: req.method,
          targetUrl: req.url,
          headers: req.headers,
          headerOrder: Object.keys(req.headers),
          bodyBase64: encodeBodyBase64(req.body),
        }),
      });
      if (!resp.ok) {
        throw new UpstreamTemporaryError(
          `Firefly proxy failed: HTTP ${resp.status}`,
          { statusCode: resp.status, errorType: "proxy" }
        );
      }
      const envelopeBytes = await readFetchResponseBytes(
        resp,
        MAX_PROXY_ENVELOPE_BYTES
      );
      let envelope: unknown;
      try {
        envelope = JSON.parse(envelopeBytes.toString("utf-8")) as unknown;
      } catch {
        throw new UpstreamTemporaryError("Firefly proxy response is invalid", {
          statusCode: resp.status,
          errorType: "proxy",
        });
      }
      const payload = parseProxyResponsePayload(envelope, req.maxResponseBytes);
      const headers: Record<string, string> = {};
      for (const [key, values] of Object.entries(payload.headers || {})) {
        if (key.toLowerCase() === "content-encoding") continue;
        headers[key.toLowerCase()] = Array.isArray(values)
          ? (values[0] ?? "")
          : String(values ?? "");
      }
      return buildResponse(payload.status, headers, async () =>
        payload.bodyBase64
          ? Buffer.from(payload.bodyBase64, "base64")
          : Buffer.alloc(0)
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener("abort", onAbort);
    }
  }
}
