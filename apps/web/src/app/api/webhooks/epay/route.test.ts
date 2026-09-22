import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

describe("Go Epay webhook transport", () => {
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

  const signedForm =
    "pid=1001&trade_no=pay%2F1&out_trade_no=order%2B1&name=%E7%A7%AF%E5%88%86+%2B+Credits&money=20.00&param=a%252Fb&sign=abc%2Bdef%3D&sign_type=MD5";

  it("preserves signed POST form encoding instead of parsing and re-encoding it", async () => {
    const request = new Request("https://app.test/api/webhooks/epay", {
      method: "POST",
      body: signedForm,
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-request-id": "epay-post",
        "x-forwarded-for": "192.0.2.8",
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response("success", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    );
    const response = await POST(request);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Go request missing");
    const [target, init] = call;
    expect(target).toBe("http://go.test/api/webhooks/epay");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(request.signal);
    if (!(init?.body instanceof ArrayBuffer))
      throw new Error("raw form body missing");
    expect(new Uint8Array(init.body)).toEqual(
      new TextEncoder().encode(signedForm)
    );
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded; charset=UTF-8"
    );
    expect(headers.get("x-request-id")).toBe("epay-post");
    expect(headers.get("x-forwarded-for")).toBe("192.0.2.8");
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
    await expect(response.text()).resolves.toBe("success");
  });

  it("preserves GET parameter order, percent encoding and repeated fields", async () => {
    const query = `${signedForm}&param=second+value`;
    const request = new Request(`https://app.test/api/webhooks/epay?${query}`);
    fetchMock.mockResolvedValueOnce(new Response("success"));
    const response = await GET(request);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Go request missing");
    const [target, init] = call;
    expect(target).toBe(`http://go.test/api/webhooks/epay?${query}`);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBe(request.signal);
    await expect(response.text()).resolves.toBe("success");
  });

  it.each([
    { status: 200, body: "fail" },
    { status: 400, body: "fail" },
    { status: 500, body: "fail" },
    { status: 503, body: "unavailable" },
  ])("preserves the provider acknowledgement $status/$body", async ({
    status,
    body,
  }) => {
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status, headers: { "retry-after": "20" } })
    );
    const response = await POST(
      new Request("https://app.test/api/webhooks/epay", {
        method: "POST",
        body: signedForm,
      })
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("20");
    await expect(response.text()).resolves.toBe(body);
  });

  it("leaves backend redirects unfollowed and propagates their location", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: "https://app.test/payment/result" },
      })
    );
    const response = await GET(
      new Request(`https://app.test/api/webhooks/epay?${signedForm}`)
    );
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://app.test/payment/result"
    );
  });

  it("propagates cancellation without replacing it with success", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementationOnce(async (_target, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    await expect(
      POST(
        new Request("https://app.test/api/webhooks/epay", {
          method: "POST",
          body: signedForm,
          signal: controller.signal,
        })
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
