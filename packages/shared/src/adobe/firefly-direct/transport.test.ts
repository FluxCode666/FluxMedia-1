/**
 * Adobe Firefly 代理传输契约测试。
 *
 * 职责：锁定 TypeScript 发送给无状态 Go 代理的严格 JSON 信封，防止重新引入
 * 会话字段或与 `services/media-upstream-proxy` 的 `DisallowUnknownFields` 漂移。
 * 使用方：packages/shared 的 DB-free Vitest 门禁；测试不执行真实网络请求。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProxyFireflyTransport } from "./transport";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProxyFireflyTransport", () => {
  it("发送 Go 代理接受的无状态严格信封", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ status: 200, headers: {}, bodyBase64: "" })
    );
    vi.stubGlobal("fetch", fetchMock);
    const transport = new ProxyFireflyTransport({
      proxyUrl: "https://proxy.example.com/",
      secret: "test-secret",
    });

    await transport.request({
      method: "GET",
      url: "https://firefly.adobe.io/v1/credits/balance",
      headers: { Authorization: "Bearer adobe-token" },
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(requestInit?.body)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual([
      "bodyBase64",
      "headerOrder",
      "headers",
      "method",
      "targetUrl",
    ]);
    expect(body).toMatchObject({
      method: "GET",
      targetUrl: "https://firefly.adobe.io/v1/credits/balance",
      headerOrder: ["Authorization"],
      bodyBase64: "",
    });
  });
});
