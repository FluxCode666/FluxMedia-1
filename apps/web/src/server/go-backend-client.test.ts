import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
import {
  GoBackendRequestError,
  requestGoJson,
  requestGoResponse,
} from "./go-backend-client";

describe("Go authenticated response transport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    vi.stubEnv("GO_BACKEND_URL", "http://go-backend.test/");
    mocks.cookies.mockResolvedValue({
      getAll: () => [{ name: "better-auth.session_token", value: "session" }],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards the session without consuming a streaming response", async () => {
    const response = new Response("csv bytes", {
      headers: { "content-type": "text/csv; charset=utf-8" },
    });
    mocks.fetch.mockResolvedValue(response);
    await expect(
      requestGoResponse("/api/admin/operations/exports/task/download", {
        method: "GET",
      })
    ).resolves.toBe(response);
    expect(response.bodyUsed).toBe(false);
    const call = mocks.fetch.mock.calls[0];
    if (!call) throw new Error("Go request missing");
    const [url, init] = call;
    expect(url).toBe(
      "http://go-backend.test/api/admin/operations/exports/task/download"
    );
    expect(new Headers(init?.headers).get("cookie")).toBe(
      "better-auth.session_token=session"
    );
    expect(init?.cache).toBe("no-store");
    expect(await response.text()).toBe("csv bytes");
  });

  it("keeps JSON and structured error behavior for existing callers", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ tasks: [] }));
    await expect(
      requestGoJson("/api/admin/operations/exports")
    ).resolves.toEqual({ tasks: [] });
    mocks.fetch.mockResolvedValueOnce(
      Response.json(
        { error: { message: "not owned", code: "NOT_FOUND" } },
        { status: 404 }
      )
    );
    await expect(
      requestGoResponse("/api/admin/operations/exports/task/download")
    ).rejects.toMatchObject({
      name: "GoBackendRequestError",
      status: 404,
      code: "NOT_FOUND",
      message: "not owned",
    });
  });

  it("preserves explicit cron authorization outside a Next request scope", async () => {
    mocks.cookies.mockRejectedValue(new Error("outside request scope"));
    mocks.fetch.mockResolvedValueOnce(Response.json({ processed: 0 }));
    await requestGoJson("/api/jobs/operations/exports/process", {
      method: "POST",
      headers: { authorization: "Bearer cron-secret" },
      body: "{}",
    });
    const headers = new Headers(mocks.fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer cron-secret");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.get("content-type")).toBe("application/json");
    mocks.fetch.mockResolvedValueOnce(
      new Response("bad gateway", { status: 502 })
    );
    await expect(
      requestGoResponse("/api/jobs/operations/exports/process")
    ).rejects.toBeInstanceOf(GoBackendRequestError);
  });
});
