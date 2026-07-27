/**
 * DNS-pinning fetch 单元测试。
 *
 * 全部 mock dns 模块与 http/https 传输层，不发起真实网络请求。
 * 覆盖：公网 IP 放行、私有 IP 阻断、混合结果阻断、DNS 失败、Host 头设置。
 */

import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock node:dns/promises
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

vi.mock("node:http", () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}));

vi.mock("node:https", () => ({
  default: { request: vi.fn(), Agent: vi.fn() },
  request: vi.fn(),
  Agent: vi.fn(),
}));

import { resolve4, resolve6 } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { fetchWithDnsPin, SsrfBlockedError } from "./dns-pin";

const mockResolve4 = vi.mocked(resolve4);
const mockResolve6 = vi.mocked(resolve6);
// eslint-disable-next-line -- 类型断言简化 mock 签名匹配
const httpRequestMock = http.request as unknown as ReturnType<typeof vi.fn>;
// eslint-disable-next-line -- 类型断言简化 mock 签名匹配
const httpsRequestMock = https.request as unknown as ReturnType<typeof vi.fn>;

/**
 * 配置 mock transport 使其返回指定的响应。
 */
function setupMockTransport(
  mock: ReturnType<typeof vi.fn>,
  statusCode: number,
  responseBody: string,
  responseHeaders: Record<string, string> = {}
) {
  mock.mockImplementation(
    (_opts: unknown, callback: (res: EventEmitter) => void) => {
      const req = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      req.write = vi.fn();
      req.end = vi.fn().mockImplementation(() => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        };
        res.statusCode = statusCode;
        res.statusMessage = "OK";
        res.headers = responseHeaders;

        callback(res);

        queueMicrotask(() => {
          res.emit("data", Buffer.from(responseBody));
          res.emit("end");
        });
      });
      req.destroy = vi.fn();
      return req;
    }
  );
}

describe("fetchWithDnsPin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows public IP (8.8.8.8) and makes request correctly", async () => {
    mockResolve4.mockResolvedValue(["8.8.8.8"]);
    setupMockTransport(httpRequestMock, 200, "image-data", {
      "content-type": "image/png",
    });

    const response = await fetchWithDnsPin("http://example.com/image.png");

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("image-data");
  });

  it("blocks private IP (192.168.1.1)", async () => {
    mockResolve4.mockResolvedValue(["192.168.1.1"]);

    await expect(
      fetchWithDnsPin("http://example.com/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("only pins a blocked address when the caller explicitly allows it", async () => {
    mockResolve4.mockResolvedValue(["10.0.0.8"]);
    setupMockTransport(httpsRequestMock, 200, "ok");

    const response = await fetchWithDnsPin(
      "https://trusted.internal/image.png",
      {
        allowBlockedAddress: ({ hostname, address }) =>
          hostname === "trusted.internal" && address === "10.0.0.8",
      }
    );

    expect(await response.text()).toBe("ok");
  });

  it("fails while streaming when the actual response exceeds the byte limit", async () => {
    mockResolve4.mockResolvedValue(["8.8.8.8"]);
    setupMockTransport(httpRequestMock, 200, "too-large");

    const response = await fetchWithDnsPin("http://example.com/image.png", {
      maxResponseBytes: 4,
    });

    await expect(response.arrayBuffer()).rejects.toThrow(
      "response exceeded 4 bytes"
    );
  });

  it("serializes FormData before writing to the pinned request", async () => {
    mockResolve4.mockResolvedValue(["8.8.8.8"]);
    let capturedOptions: RequestOptions | undefined;
    let requestBody: Buffer | undefined;
    httpRequestMock.mockImplementation(
      (opts: unknown, callback: (res: EventEmitter) => void) => {
        capturedOptions = opts as RequestOptions;
        const req = new EventEmitter() as EventEmitter & {
          write: (body: Buffer) => void;
          end: () => void;
          destroy: ReturnType<typeof vi.fn>;
        };
        req.write = (body) => {
          requestBody = body;
        };
        req.end = () => {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            statusMessage: string;
            headers: Record<string, string>;
          };
          res.statusCode = 200;
          res.statusMessage = "OK";
          res.headers = {};
          callback(res);
          queueMicrotask(() => res.emit("end"));
        };
        req.destroy = vi.fn();
        return req;
      }
    );
    const form = new FormData();
    form.set("prompt", "test");

    await fetchWithDnsPin("http://example.com/images/edits", {
      method: "POST",
      body: form,
    });

    expect(
      (capturedOptions?.headers as Record<string, string>)["content-type"]
    ).toMatch(/^multipart\/form-data; boundary=/);
    expect(requestBody?.toString()).toContain('name="prompt"');
  });

  it("blocks loopback address (127.0.0.1)", async () => {
    mockResolve4.mockResolvedValue(["127.0.0.1"]);

    await expect(
      fetchWithDnsPin("http://evil.com/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks link-local address (169.254.169.254)", async () => {
    mockResolve4.mockResolvedValue(["169.254.169.254"]);

    await expect(
      fetchWithDnsPin("http://metadata.example.com/latest")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks IPv6 loopback (::1) via resolve6 fallback", async () => {
    mockResolve4.mockRejectedValue(new Error("ENODATA"));
    mockResolve6.mockResolvedValue(["::1"]);

    await expect(
      fetchWithDnsPin("http://evil-v6.com/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks mixed results (one public + one private)", async () => {
    mockResolve4.mockResolvedValue(["8.8.8.8", "192.168.1.1"]);

    await expect(
      fetchWithDnsPin("http://rebinding.evil.com/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks a private IPv6 result even when the IPv4 result is public", async () => {
    mockResolve4.mockResolvedValue(["8.8.8.8"]);
    mockResolve6.mockResolvedValue(["fd00::1"]);

    await expect(
      fetchWithDnsPin("https://dual-stack.example/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("throws SsrfBlockedError when DNS resolution fails entirely", async () => {
    mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));
    mockResolve6.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(
      fetchWithDnsPin("http://nonexistent.invalid/image.png")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(
      fetchWithDnsPin("http://nonexistent.invalid/image.png")
    ).rejects.toThrow("DNS resolution failed");
  });

  it("sets Host header correctly with IP pinning transparent", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);

    let capturedOptions: RequestOptions | undefined;
    httpRequestMock.mockImplementation(
      (opts: unknown, callback: (res: EventEmitter) => void) => {
        capturedOptions = opts as RequestOptions;
        const req = new EventEmitter() as EventEmitter & {
          write: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
          destroy: ReturnType<typeof vi.fn>;
        };
        req.write = vi.fn();
        req.end = vi.fn().mockImplementation(() => {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            statusMessage: string;
            headers: Record<string, string>;
          };
          res.statusCode = 200;
          res.statusMessage = "OK";
          res.headers = {};
          callback(res);
          queueMicrotask(() => {
            res.emit("data", Buffer.from("ok"));
            res.emit("end");
          });
        });
        req.destroy = vi.fn();
        return req;
      }
    );

    await fetchWithDnsPin("http://example.com:8080/path?q=1");

    // hostname 被替换为 pinned IP
    expect(capturedOptions?.hostname).toBe("93.184.216.34");
    // Host 头保留原始主机名:端口
    expect((capturedOptions?.headers as Record<string, string>)?.Host).toBe(
      "example.com:8080"
    );
    // path 保留完整
    expect(capturedOptions?.path).toBe("/path?q=1");
    expect(capturedOptions?.port).toBe(8080);
  });

  it("sets servername for SNI on HTTPS requests", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);

    let capturedOptions: RequestOptions | undefined;
    httpsRequestMock.mockImplementation(
      (opts: unknown, callback: (res: EventEmitter) => void) => {
        capturedOptions = opts as RequestOptions;
        const req = new EventEmitter() as EventEmitter & {
          write: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
          destroy: ReturnType<typeof vi.fn>;
        };
        req.write = vi.fn();
        req.end = vi.fn().mockImplementation(() => {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            statusMessage: string;
            headers: Record<string, string>;
          };
          res.statusCode = 200;
          res.statusMessage = "OK";
          res.headers = {};
          callback(res);
          queueMicrotask(() => {
            res.emit("data", Buffer.from("ok"));
            res.emit("end");
          });
        });
        req.destroy = vi.fn();
        return req;
      }
    );

    await fetchWithDnsPin("https://secure.example.com/img.png");

    expect((capturedOptions as Record<string, unknown>)?.servername).toBe(
      "secure.example.com"
    );
    expect(capturedOptions?.hostname).toBe("93.184.216.34");
    expect(capturedOptions?.port).toBe(443);
  });

  it("validates IP literal directly without DNS lookup", async () => {
    setupMockTransport(httpRequestMock, 200, "ok");

    const response = await fetchWithDnsPin("http://8.8.4.4/image.png");
    expect(response.status).toBe(200);
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });

  it("blocks private IP literal in URL", async () => {
    await expect(
      fetchWithDnsPin("http://10.0.0.1/secret")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it("blocks a bracketed private IPv6 literal without DNS lookup", async () => {
    await expect(
      fetchWithDnsPin("https://[::1]/secret")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });

  it("blocks 10.x.x.x range", async () => {
    mockResolve4.mockResolvedValue(["10.255.255.1"]);
    await expect(fetchWithDnsPin("http://evil.com/x")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks 0.0.0.0/8 range", async () => {
    mockResolve4.mockResolvedValue(["0.0.0.1"]);
    await expect(fetchWithDnsPin("http://evil.com/x")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks 172.16.0.0/12 range", async () => {
    mockResolve4.mockResolvedValue(["172.20.10.1"]);
    await expect(fetchWithDnsPin("http://evil.com/x")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks CGNAT 100.64.0.0/10 range", async () => {
    mockResolve4.mockResolvedValue(["100.100.100.1"]);
    await expect(fetchWithDnsPin("http://evil.com/x")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });
});
