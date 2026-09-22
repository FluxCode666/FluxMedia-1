import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("Go export download transport", () => {
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

  it("preserves browser authentication, ranges, file headers and CSV bytes", async () => {
    fetchMock.mockResolvedValue(
      new Response("a,b\r\n", {
        status: 206,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition":
            'attachment; filename="operations-user_growth-task-1.csv"',
          "content-range": "bytes 0-4/50",
          "cache-control": "private, no-store",
        },
      })
    );
    const request = new Request(
      "https://app.test/api/admin/operations/exports/task-1/download",
      {
        headers: {
          cookie: "better-auth.session_token=session",
          range: "bytes=0-4",
        },
      }
    );
    const response = await GET(request);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Go request missing");
    const [url, init] = call;
    expect(url).toBe(
      "http://go.test/api/admin/operations/exports/task-1/download"
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe("better-auth.session_token=session");
    expect(headers.get("range")).toBe("bytes=0-4");
    expect(init?.signal).toBe(request.signal);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-4/50");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="operations-user_growth-task-1.csv"'
    );
    await expect(response.text()).resolves.toBe("a,b\r\n");
  });

  it.each([
    401, 403, 404, 409, 503,
  ])("preserves Go authorization/availability response %s", async (status) => {
    const payload = {
      error: { code: "EXPORT_UNAVAILABLE", message: "not available" },
    };
    fetchMock.mockResolvedValue(Response.json(payload, { status }));
    const response = await GET(
      new Request(
        "https://app.test/api/admin/operations/exports/task-1/download"
      )
    );
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(payload);
  });

  it("closes the upstream stream when the client cancels", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel,
        })
      )
    );
    const response = await GET(
      new Request(
        "https://app.test/api/admin/operations/exports/task-1/download"
      )
    );
    await response.body?.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("passes an already canceled request to upstream fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    await expect(
      GET(
        new Request(
          "https://app.test/api/admin/operations/exports/task-1/download",
          { signal: controller.signal }
        )
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
