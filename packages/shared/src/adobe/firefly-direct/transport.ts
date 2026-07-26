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

export type FireflyTransportRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer | Uint8Array | string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
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
      return buildResponse(resp.status, headers, async () =>
        Buffer.from(await resp.arrayBuffer())
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener("abort", onAbort);
    }
  }
}

type ProxyResponsePayload = {
  status: number;
  headers?: Record<string, string[]>;
  bodyBase64?: string;
};

/** Go 旁路代理传输（TLS 伪装），协议与 chatgpt-web-proxy 一致。 */
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
        const text = await resp.text().catch(() => "");
        throw new Error(
          `Firefly proxy failed: HTTP ${resp.status}${text ? ` ${text.slice(0, 300)}` : ""}`
        );
      }
      const payload = (await resp.json()) as ProxyResponsePayload;
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
