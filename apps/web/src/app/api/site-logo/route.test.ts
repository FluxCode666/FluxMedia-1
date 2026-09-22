import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const fetchMock = vi.fn<typeof fetch>();

describe("GET /api/site-logo Go transport", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GO_BACKEND_URL", "http://go-backend:8080/");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    "/assets/icon.svg",
    "https://cdn.example.com/brand/logo.webp",
  ])("preserves the Go redirect to %s without following it", async (location) => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location, "cache-control": "no-store, max-age=0" },
      })
    );
    const request = new Request(
      "https://media.example.com/api/site-logo?v=brand",
      {
        headers: { host: "media.example.com", "x-forwarded-proto": "https" },
      }
    );
    const response = await GET(request);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://go-backend:8080/api/site-logo?v=brand",
      expect.objectContaining({
        method: "GET",
        body: undefined,
        cache: "no-store",
        redirect: "manual",
        signal: request.signal,
      })
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has("host")).toBe(false);
    expect(headers.get("x-forwarded-proto")).toBe("https");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(location);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("preserves backend error status and payload", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { message: "unavailable" } }, { status: 503 })
    );
    const response = await GET(
      new Request("https://media.example.com/api/site-logo")
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { message: "unavailable" },
    });
  });
});
