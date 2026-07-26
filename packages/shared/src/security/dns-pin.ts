/**
 * DNS-pinning fetch：解决 DNS 重绑定（rebinding）攻击的连接层防护。
 *
 * 问题：传统 SSRF 防护在 DNS 解析后校验 IP，但实际连接时可能获得不同的 IP
 * （攻击者在第二次 DNS 查询返回内网 IP）。
 *
 * 方案：
 * 1. 解析主机名，获得所有 IP
 * 2. 校验所有 IP 均为公网地址（任一内网即拒绝）
 * 3. 将 URL 中的主机名替换为第一个合法公网 IP，强制连接到该 IP
 * 4. 设置 Host 头以保留虚拟主机路由
 * 5. HTTPS 场景通过 servername 指定 SNI 以通过证书校验
 *
 * 关键设计决策：
 * - 使用 node:http / node:https 原生模块而非 globalThis.fetch，
 *   因为 Next.js 16 patchFetch() 会替换 globalThis.fetch 且不可配置。
 * - 无条件执行（不检测环境，不区分生产/测试），避免被绕过。
 * - redirect:"manual" 由本模块强制，调用方负责对重定向目标重新调用 fetchWithDnsPin。
 *
 * 使用方：safe-image-fetch.ts 中的 fetchPublicImage / fetchPublicCallback
 * 依赖：ip-validation.ts（纯函数 IP 校验）
 */

import { resolve4, resolve6 } from "node:dns/promises";
import type { IncomingMessage, RequestOptions } from "node:http";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { isBlockedIP } from "./ip-validation";

/**
 * SSRF 请求被阻断时抛出的错误类型。
 * 调用方可据此向用户返回友好错误而非暴露内部细节。
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** fetchWithDnsPin 的可选配置 */
export interface DnsPinFetchOptions {
  /** 请求方法，默认 GET */
  method?: string;
  /** 额外请求头（Host 头由内部设置，不应在此传入） */
  headers?: Record<string, string>;
  /** 请求正文；FormData 会在连接前序列化并自动补 multipart Content-Type。 */
  body?:
    | string
    | Buffer
    | FormData
    | URLSearchParams
    | Uint8Array
    | ArrayBuffer;
  /** 超时毫秒数，默认 10000（10秒） */
  timeoutMs?: number;
  /** AbortSignal 用于外部取消 */
  signal?: AbortSignal;
  /** 实际响应体上限；超限时销毁连接并让读取方失败。 */
  maxResponseBytes?: number;
  /**
   * 仅供部署级私网上游策略注入的例外判断；默认不存在，所有私网/保留地址仍拒绝。
   * 调用方必须先校验 URL 协议、主机和凭据，不能把用户输入直接变成例外。
   */
  allowBlockedAddress?: (input: {
    hostname: string;
    address: string;
  }) => boolean;
}

type SerializedRequestBody = {
  body: string | Buffer | undefined;
  headers: Record<string, string>;
};

/** 判断调用方是否已显式设置某个请求头，忽略大小写。 */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some(
    (headerName) => headerName.toLowerCase() === normalizedName
  );
}

/** 将 fetch 风格正文变为 node:http 可写字节并补齐自动生成的 Content-Type。 */
async function serializeRequestBody(
  body: DnsPinFetchOptions["body"],
  inputHeaders: Record<string, string>
): Promise<SerializedRequestBody> {
  const headers = { ...inputHeaders };
  if (body === undefined) return { body: undefined, headers };
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    return { body, headers };
  }
  if (body instanceof Uint8Array) {
    return { body: Buffer.from(body), headers };
  }
  if (body instanceof ArrayBuffer) {
    return { body: Buffer.from(new Uint8Array(body)), headers };
  }

  const request = new Request("https://dns-pin.invalid/body", {
    method: "POST",
    body,
  });
  if (!hasHeader(headers, "content-type")) {
    const contentType = request.headers.get("content-type");
    if (contentType) headers["content-type"] = contentType;
  }
  return {
    body: Buffer.from(await request.arrayBuffer()),
    headers,
  };
}

/**
 * 解析主机名并校验所有返回 IP 均为公网地址。
 *
 * @param hostname 待解析的主机名
 * @returns 第一个合法公网 IPv4 地址
 * @throws SsrfBlockedError 若任一 IP 为私有/保留地址
 * @throws Error 若 DNS 解析失败或无结果
 */
async function resolveAndValidate(
  hostname: string,
  allowBlockedAddress?: DnsPinFetchOptions["allowBlockedAddress"]
): Promise<string> {
  const [ipv4Result, ipv6Result] = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);
  const ipv4 =
    ipv4Result.status === "fulfilled" && Array.isArray(ipv4Result.value)
      ? ipv4Result.value
      : [];
  const ipv6 =
    ipv6Result.status === "fulfilled" && Array.isArray(ipv6Result.value)
      ? ipv6Result.value
      : [];
  const addresses = [...ipv4, ...ipv6];

  if (addresses.length === 0) {
    throw new SsrfBlockedError(
      `DNS resolution failed for hostname: ${hostname}`
    );
  }

  // 校验所有解析出的 IP 均为公网地址（ANY 内网即阻断）
  for (const ip of addresses) {
    if (isBlockedIP(ip) && !allowBlockedAddress?.({ hostname, address: ip })) {
      throw new SsrfBlockedError(
        "Image URL resolved to a private/reserved IP address."
      );
    }
  }

  // 前面已确认数组非空；显式分支避免用非空断言掩盖运行时不变量。
  const pinnedAddress = addresses[0];
  if (!pinnedAddress) {
    throw new SsrfBlockedError(
      `DNS resolution failed for hostname: ${hostname}`
    );
  }
  return pinnedAddress;
}

/**
 * 使用 node:http/node:https 发起请求，将主机名 pin 到已校验的 IP。
 *
 * 关键行为：
 * - 强制 redirect:"manual"（返回 3xx 响应本身，不跟踪重定向）
 * - 对 HTTPS 设置 servername 以保持 SNI/证书校验
 * - 设置 Host 头以保留虚拟主机路由
 * - 超时后自动销毁请求
 *
 * @param url 完整 URL（http:// 或 https://）
 * @param init 可选的请求配置
 * @returns 标准 Response 对象（Node.js 风格包装为 Web Response）
 * @throws SsrfBlockedError 若目标解析到内网地址
 * @throws Error 若请求超时或网络错误
 */
export async function fetchWithDnsPin(
  url: string | URL,
  init?: DnsPinFetchOptions
): Promise<Response> {
  const parsed = typeof url === "string" ? new URL(url) : new URL(url.href);
  const isHttps = parsed.protocol === "https:";
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const timeoutMs = init?.timeoutMs ?? 10_000;

  // 若 URL 已是 IP 字面量，直接校验
  const isLiteralIP = isIP(hostname) !== 0;

  let pinnedIP: string;
  if (isLiteralIP) {
    if (
      isBlockedIP(hostname) &&
      !init?.allowBlockedAddress?.({ hostname, address: hostname })
    ) {
      throw new SsrfBlockedError(
        "Image URL resolved to a private/reserved IP address."
      );
    }
    pinnedIP = hostname;
  } else {
    pinnedIP = await resolveAndValidate(hostname, init?.allowBlockedAddress);
  }

  const serialized = await serializeRequestBody(
    init?.body,
    init?.headers ?? {}
  );

  // 构造请求选项，将 host 替换为 pinned IP
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;

  const headers = Object.fromEntries(
    Object.entries(serialized.headers).filter(
      ([headerName]) => headerName.toLowerCase() !== "host"
    )
  );
  headers.Host = parsed.port ? `${hostname}:${parsed.port}` : hostname;

  const requestOptions: RequestOptions = {
    hostname: pinnedIP,
    port,
    path: parsed.pathname + parsed.search,
    method: init?.method ?? "GET",
    headers,
    timeout: timeoutMs,
  };

  // HTTPS: 设置 servername 以通过 TLS 证书校验（SNI）
  if (isHttps && !isLiteralIP) {
    (requestOptions as https.RequestOptions).servername = hostname;
    // 禁止 TLS session 复用到不同主机（防止绕过 pin）
    requestOptions.agent = new https.Agent({
      servername: hostname,
      maxSockets: 1,
    });
  }

  const transport = isHttps ? https : http;

  return new Promise<Response>((resolve, reject) => {
    // 处理外部 AbortSignal
    if (init?.signal?.aborted) {
      reject(new Error("Request aborted"));
      return;
    }

    const req = transport.request(requestOptions, (res: IncomingMessage) => {
      const responseHeaders = new Headers();

      // 转换 Node.js 响应头到 Web Headers。
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const headerValue of value) {
            responseHeaders.append(key, headerValue);
          }
        } else {
          responseHeaders.set(key, value);
        }
      }

      const status = res.statusCode ?? 200;
      const hasNoResponseBody =
        status === 101 || status === 204 || status === 205 || status === 304;
      if (hasNoResponseBody && typeof res.resume === "function") res.resume();
      const body = hasNoResponseBody
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              let total = 0;
              let finished = false;
              const fail = (error: Error) => {
                if (finished) return;
                finished = true;
                controller.error(error);
              };
              res.on("data", (chunk: Buffer) => {
                if (finished) return;
                total += chunk.byteLength;
                if (
                  init?.maxResponseBytes !== undefined &&
                  total > init.maxResponseBytes
                ) {
                  const error = new Error(
                    `DNS pin response exceeded ${init.maxResponseBytes} bytes`
                  );
                  fail(error);
                  if (typeof res.destroy === "function") res.destroy(error);
                  return;
                }
                controller.enqueue(new Uint8Array(chunk));
              });
              res.on("end", () => {
                if (finished) return;
                finished = true;
                controller.close();
              });
              res.on("error", (error: Error) => fail(error));
            },
            cancel() {
              if (typeof res.destroy === "function") res.destroy();
            },
          });

      resolve(
        new Response(body, {
          status,
          statusText: res.statusMessage ?? "",
          headers: responseHeaders,
        })
      );
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err: Error) => {
      reject(err);
    });

    // 外部取消
    if (init?.signal) {
      const onAbort = () => {
        req.destroy();
        reject(new Error("Request aborted"));
      };
      init.signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => {
        init.signal?.removeEventListener("abort", onAbort);
      });
    }

    // 写入请求正文
    if (serialized.body !== undefined) {
      req.write(serialized.body);
    }
    req.end();
  });
}
