import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("Go Creem webhook transport", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GO_BACKEND_URL", "http://go.test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("preserves the exact signed JSON bytes and signature headers", async () => {
    const body =
      '{\n "eventType":"checkout.completed", "id":"evt-1",\n "object":{"name":"积分 + Credits","amount":1999,"literal":"\\u003c"}\n}\n';
    const signature = createHmac("sha256", "test-webhook-secret")
      .update(body)
      .digest("hex");
    const request = new Request("https://app.test/api/webhooks/creem", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "creem-signature": signature,
        "x-request-id": "creem-request",
      },
    });
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { received: true },
        { headers: { "x-request-id": "go-request" } }
      )
    );
    const response = await POST(request);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Go request missing");
    const [target, init] = call;
    expect(target).toBe("http://go.test/api/webhooks/creem");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(request.signal);
    if (!(init?.body instanceof ArrayBuffer))
      throw new Error("raw signed body missing");
    const bytes = new Uint8Array(init.body);
    expect(bytes).toEqual(new TextEncoder().encode(body));
    expect(
      createHmac("sha256", "test-webhook-secret").update(bytes).digest("hex")
    ).toBe(signature);
    const headers = new Headers(init.headers);
    expect(headers.get("creem-signature")).toBe(signature);
    expect(headers.get("x-request-id")).toBe("creem-request");
    expect(headers.get("content-type")).toBe("application/json");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("go-request");
    await expect(response.json()).resolves.toEqual({ received: true });
  });

  it.each([
    400, 401, 409, 500, 503,
  ])("preserves backend rejection %s so webhook retries remain correct", async (status) => {
    const body = "signature or fulfillment rejected";
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status,
        headers: { "content-type": "text/plain", "retry-after": "10" },
      })
    );
    const response = await POST(
      new Request("https://app.test/api/webhooks/creem", {
        method: "POST",
        body: "malformed signed input",
      })
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe(body);
  });

  it("does not acknowledge an interrupted webhook transport", async () => {
    const controller = new AbortController();
    const request = new Request("https://app.test/api/webhooks/creem", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });
    fetchMock.mockImplementationOnce(async (_target, init) => {
      expect(init?.signal).toBe(request.signal);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    await expect(POST(request)).rejects.toMatchObject({ name: "AbortError" });
  });
});
