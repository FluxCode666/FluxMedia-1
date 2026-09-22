import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("Go moderation transport", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GO_BACKEND_URL", "http://go.test/");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("preserves raw UTF-8 input and authentication headers for Go", async () => {
    const body =
      '{\n  "prompt": "图像 + 审核", "images": ["data:image/png;base64,YWJj"],\n  "effectiveBlockRiskLevel": "low"\n}\n';
    const request = new Request("https://app.test/moderate?trace=one%2Ftwo", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: "Bearer moderation-proxy-secret",
        "x-request-id": "moderation-request",
        "x-flux-principal": "signed-principal",
        "x-flux-principal-signature": "principal-signature",
        host: "app.test",
        "content-length": "999",
      },
    });
    fetchMock.mockResolvedValueOnce(
      Response.json({ decision: "allow", provider: "openai" })
    );
    const response = await POST(request);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Go request missing");
    const [target, init] = call;
    expect(target).toBe("http://go.test/moderate?trace=one%2Ftwo");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(request.signal);
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("manual");
    if (!(init?.body instanceof ArrayBuffer))
      throw new Error("raw request body missing");
    expect(new Uint8Array(init.body)).toEqual(new TextEncoder().encode(body));
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer moderation-proxy-secret");
    expect(headers.get("x-flux-principal")).toBe("signed-principal");
    expect(headers.get("x-flux-principal-signature")).toBe(
      "principal-signature"
    );
    expect(headers.get("x-request-id")).toBe("moderation-request");
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(headers.has("host")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
    await expect(response.json()).resolves.toEqual({
      decision: "allow",
      provider: "openai",
    });
  });

  it.each([
    400, 401, 403, 413, 429, 503,
  ])("preserves Go validation/authentication/availability status %s", async (status) => {
    const payload = {
      error: { code: "MODERATION_UNAVAILABLE", message: "Unavailable" },
    };
    fetchMock.mockResolvedValueOnce(
      Response.json(payload, { status, headers: { "retry-after": "15" } })
    );
    const response = await POST(
      new Request("https://app.test/moderate", {
        method: "POST",
        body: "invalid JSON",
      })
    );
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization")
    ).toBe(false);
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("15");
    await expect(response.json()).resolves.toEqual(payload);
  });

  it("passes cancellation to Go without manufacturing a moderation decision", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementationOnce(async (_target, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    await expect(
      POST(
        new Request("https://app.test/moderate", {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        })
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
