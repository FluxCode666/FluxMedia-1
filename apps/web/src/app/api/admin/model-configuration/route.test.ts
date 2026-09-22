/** Model configuration routes preserve the Go request/response contract.
 * Validation, cover processing, permissions, and writes are covered by Go's
 * model_configuration_integration_test.go against PostgreSQL and real storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, POST } from "./route";

const fetchGo = vi.fn<typeof fetch>();
const path = "https://app.example.com/api/admin/model-configuration";

beforeEach(() => {
  vi.stubEnv("GO_BACKEND_URL", "http://go.internal:8080/");
  vi.stubGlobal("fetch", fetchGo);
  fetchGo.mockReset();
  fetchGo.mockResolvedValue(Response.json({ revision: 3 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function forwardedRequest(): RequestInit {
  const init = fetchGo.mock.calls[0]?.[1];
  if (!init) throw new Error("Go request was not issued");
  return init;
}

describe("Go model configuration proxy", () => {
  it("forwards catalog query and session identity", async () => {
    const catalog = { entries: [{ configKey: "gpt-image-2", revision: 2 }], canEdit: true };
    fetchGo.mockResolvedValueOnce(Response.json(catalog));
    const response = await GET(new Request(`${path}?category=image&visible=true`, {
      headers: { cookie: "better-auth.session_token=signed-session", "x-request-id": "catalog-test", host: "app.example.com" },
    }));
    expect(fetchGo).toHaveBeenCalledOnce();
    expect(fetchGo.mock.calls[0]?.[0]).toBe("http://go.internal:8080/api/admin/model-configuration?category=image&visible=true");
    const init = forwardedRequest();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("cookie")).toBe("better-auth.session_token=signed-session");
    expect(new Headers(init.headers).get("x-request-id")).toBe("catalog-test");
    expect(new Headers(init.headers).has("host")).toBe(false);
    expect(init.cache).toBe("no-store");
    expect(await response.json()).toEqual(catalog);
  });

  it("preserves multipart boundary, original file bytes and fields", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 60, 62]);
    const form = new FormData();
    form.append("category", "image");
    form.append("configKey", "gpt-image-2");
    form.append("clientRequestId", "6b7d1204-3f43-4da7-b2b5-b7540927e462");
    form.append("expectedRevision", "2");
    form.append("description", "模型封面");
    form.append("coverChange", "replace");
    form.append("cover", new File([bytes], "封面.png", { type: "image/png" }));
    const request = new Request(path, {
      method: "POST",
      headers: { origin: "https://app.example.com", cookie: "better-auth.session_token=admin", "content-length": "1" },
      body: form,
    });
    const originalBody = await request.clone().arrayBuffer();
    await POST(request);
    const init = forwardedRequest();
    expect(init.method).toBe("POST");
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(new Uint8Array(originalBody));
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe(request.headers.get("content-type"));
    expect(headers.get("origin")).toBe("https://app.example.com");
    expect(headers.get("cookie")).toBe("better-auth.session_token=admin");
    expect(headers.has("content-length")).toBe(false);
    const received = await new Request(path, { method: "POST", headers, body: init.body }).formData();
    expect(received.get("description")).toBe("模型封面");
    expect(received.get("clientRequestId")).toBe(form.get("clientRequestId"));
    const cover = received.get("cover") as File;
    expect(cover.name).toBe("封面.png");
    expect(cover.type).toBe("image/png");
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(bytes);
  });

  it("forwards custom model deletion with revision and request ID", async () => {
    const command = JSON.stringify({ category: "video", configKey: "custom-video", isCustom: true, expectedRevision: 4, clientRequestId: "delete-request" });
    fetchGo.mockResolvedValueOnce(Response.json({ deleted: true, revision: 5 }));
    const response = await DELETE(new Request(path, { method: "DELETE", headers: { "content-type": "application/json", cookie: "better-auth.session_token=admin" }, body: command }));
    const init = forwardedRequest();
    expect(init.method).toBe("DELETE");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(command);
    expect(await response.json()).toEqual({ deleted: true, revision: 5 });
  });

  it.each([
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [409, "REVISION_CONFLICT"],
    [413, "PAYLOAD_TOO_LARGE"],
    [503, "STORAGE_UNAVAILABLE"],
  ])("preserves Go status %i and its error body", async (status, code) => {
    const body = JSON.stringify({ error: { code, message: "Go 返回的具体错误", details: { expectedRevision: 4 } } });
    fetchGo.mockResolvedValueOnce(new Response(body, { status, headers: { "content-type": "application/json", "retry-after": "2", "x-request-id": "go-trace" } }));
    const response = await POST(new Request(path, { method: "POST", body: "invalid upstream input", headers: { origin: "https://untrusted.example" } }));
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("x-request-id")).toBe("go-trace");
    expect(new Headers(forwardedRequest().headers).get("origin")).toBe("https://untrusted.example");
  });

  it("keeps redirects manual and propagates authentication response headers", async () => {
    fetchGo.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/login", "set-cookie": "better-auth.session_token=; Max-Age=0; HttpOnly" } }));
    const response = await GET(new Request(path));
    expect(forwardedRequest().redirect).toBe("manual");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("passes caller cancellation to the Go fetch", async () => {
    const controller = new AbortController();
    const request = new Request(path, { signal: controller.signal });
    await GET(request);
    expect(forwardedRequest().signal).toBe(request.signal);
    controller.abort();
    expect(forwardedRequest().signal?.aborted).toBe(true);
  });
});
