/**
 * Adobe IMS Express 会话鉴权的无网络回归测试。
 *
 * 使用方：Firefly direct 成员凭据刷新与余额同步。
 * 关键依赖：以内存 FireflyTransport 断言请求身份，避免测试接触真实 Cookie 或数据库。
 */
import { describe, expect, it } from "vitest";
import {
  fetchAccountInfo,
  fetchCreditsBalance,
  IMS_DEFAULT_SCOPE,
  IMS_FIREFLY_DEFAULT_SCOPE,
  normalizeCookieString,
  refreshAccessTokenFromCookie,
} from "./auth";
import { AuthError, UpstreamTemporaryError } from "./errors";
import type {
  FireflyTransport,
  FireflyTransportRequest,
  FireflyTransportResponse,
} from "./transport";

function jsonResponse(status: number, body: unknown): FireflyTransportResponse {
  const bytes = Buffer.from(JSON.stringify(body), "utf-8");
  return {
    status,
    headers: {},
    bytes: async () => bytes,
    text: async () => bytes.toString("utf-8"),
    json: async () => body,
  };
}

class MockTransport implements FireflyTransport {
  calls: FireflyTransportRequest[] = [];

  constructor(private readonly response: FireflyTransportResponse) {}

  async request(
    request: FireflyTransportRequest
  ): Promise<FireflyTransportResponse> {
    this.calls.push(request);
    return this.response;
  }
}

function makeToken(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url")}.sig`;
}

describe("Adobe IMS Express 会话", () => {
  it("使用 projectx_webapp、精简 scope 与 Express 来源刷新 Cookie", async () => {
    const transport = new MockTransport(
      jsonResponse(200, { access_token: "access-token", expires_in: 3600 })
    );

    await refreshAccessTokenFromCookie(transport, "aux_sid=abc", {
      fetchAccount: false,
    });

    const request = transport.calls[0];
    expect(request?.headers.Origin).toBe("https://new.express.adobe.com");
    expect(request?.headers.Referer).toBe("https://new.express.adobe.com/");
    const form = new URLSearchParams(String(request?.body));
    expect(form.get("client_id")).toBe("projectx_webapp");
    expect(form.get("scope")).toBe(IMS_DEFAULT_SCOPE);
    expect(form.get("scope")).toBe("AdobeID,firefly_api,openid");
  });

  it("导出扩展 JSON 只提取 Cookie，不把 session header 当作 Cookie", () => {
    expect(
      normalizeCookieString(
        JSON.stringify({
          cookie: "aux_sid=abc; ims=def",
          headers: { "x-arp-session-id": "session-value" },
        })
      )
    ).toBe("aux_sid=abc; ims=def");
  });

  it("使用 clio-playground-web、完整 scope 与 Firefly 来源刷新 Cookie", async () => {
    const transport = new MockTransport(
      jsonResponse(200, { access_token: "firefly-token", expires_in: 3600 })
    );

    await refreshAccessTokenFromCookie(transport, "aux_sid=abc", {
      profile: "firefly",
      fetchAccount: false,
    });

    const request = transport.calls[0];
    expect(request?.headers.Origin).toBe("https://firefly.adobe.com");
    expect(request?.headers.Referer).toBe("https://firefly.adobe.com/");
    const form = new URLSearchParams(String(request?.body));
    expect(form.get("client_id")).toBe("clio-playground-web");
    expect(form.get("scope")).toBe(IMS_FIREFLY_DEFAULT_SCOPE);
    expect(form.get("scope")).toContain("pps.read");
  });

  it("拒绝与请求 Profile 不一致的 IMS Token", async () => {
    const transport = new MockTransport(
      jsonResponse(200, {
        access_token: makeToken({ client_id: "projectx_webapp" }),
        expires_in: 3600,
      })
    );

    await expect(
      refreshAccessTokenFromCookie(transport, "aux_sid=abc", {
        profile: "firefly",
        fetchAccount: false,
      })
    ).rejects.toThrow("refresh response token client_id mismatch");
  });

  it("刷新结果不携带包含 access_token 的原始响应", async () => {
    const transport = new MockTransport(
      jsonResponse(200, {
        access_token: "access-token-must-not-be-in-raw",
        expires_in: 3600,
        nested: { cookie: "aux_sid=must-not-leak" },
      })
    );

    const result = await refreshAccessTokenFromCookie(
      transport,
      "aux_sid=abc",
      { fetchAccount: false }
    );

    expect(Object.keys(result).sort()).toEqual([
      "accessToken",
      "account",
      "expiresIn",
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("使用结构化错误分类状态且不拼接上游敏感正文", async () => {
    const authTransport = new MockTransport(
      jsonResponse(401, {
        error: "invalid_token",
        access_token: "upstream-secret-token",
      })
    );
    const temporaryTransport = new MockTransport(
      jsonResponse(503, { cookie: "aux_sid=upstream-secret-cookie" })
    );

    const authError = await refreshAccessTokenFromCookie(
      authTransport,
      "aux_sid=abc",
      { fetchAccount: false }
    ).catch((error: unknown) => error);
    const temporaryError = await refreshAccessTokenFromCookie(
      temporaryTransport,
      "aux_sid=abc",
      { fetchAccount: false }
    ).catch((error: unknown) => error);

    expect(authError).toBeInstanceOf(AuthError);
    expect(temporaryError).toBeInstanceOf(UpstreamTemporaryError);
    expect(String(authError)).not.toContain("upstream-secret-token");
    expect(String(temporaryError)).not.toContain("upstream-secret-cookie");
  });

  it("解析前拒绝超过固定上限的 IMS 响应", async () => {
    const oversized = Buffer.alloc(300_000, 97);
    const transport = new MockTransport({
      status: 200,
      headers: {},
      bytes: async () => oversized,
      text: async () => oversized.toString("utf-8"),
      json: async () => ({ access_token: "must-not-be-read" }),
    });

    await expect(
      refreshAccessTokenFromCookie(transport, "aux_sid=abc", {
        fetchAccount: false,
      })
    ).rejects.toThrow("response exceeded size limit");
  });

  it("查询余额也携带 Express 来源", async () => {
    const transport = new MockTransport(
      jsonResponse(200, {
        total: { quota: { total: 100, used: 25, available: 75 } },
      })
    );

    await fetchCreditsBalance(transport, makeToken({ user_id: "user-1" }));

    const headers = transport.calls[0]?.headers;
    expect(headers?.["x-api-key"]).toBe("SunbreakWebUI1");
    expect(headers?.Origin).toBe("https://new.express.adobe.com");
    expect(headers?.Referer).toBe("https://new.express.adobe.com/");
  });

  it("账号展示字段命中疑似凭据模式时不进入返回值", async () => {
    const transport = new MockTransport(
      jsonResponse(200, {
        displayName: "Authorization: Bearer upstream-secret-token",
        email: "operator@example.com",
        userId: "adobe-user-1",
        raw: { cookie: "aux_sid=upstream-secret-cookie" },
      })
    );

    await expect(fetchAccountInfo(transport, "safe-token")).resolves.toEqual({
      displayName: "",
      email: "operator@example.com",
      userId: "adobe-user-1",
    });
  });
});
