import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const fetchMock = vi.fn<typeof fetch>();

describe("POST /api/upload/presigned Go transport", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GO_BACKEND_URL", "http://go-backend:8080");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards exact upload metadata and session; returns Go storage URL fields", async () => {
    const body = JSON.stringify({
      filename: "文档.pdf",
      contentType: "application/pdf",
      fileSize: 1024,
    });
    const payload = {
      presignedUrl: "https://signed.example.test/object?signature=a%2Bb",
      fileKey: "uploads/user/file.pdf",
      fileUrl: "/api/storage/bucket/uploads/user/file.pdf",
      contentType: "application/pdf",
      expiresIn: 3600,
    };
    fetchMock.mockResolvedValue(Response.json(payload));
    const request = new Request(
      "https://media.example.com/api/upload/presigned",
      {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          cookie: "session=test",
          host: "media.example.com",
          "content-length": String(new TextEncoder().encode(body).length),
        },
      }
    );
    const response = await POST(request);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://go-backend:8080/api/upload/presigned",
      expect.objectContaining({ method: "POST", signal: request.signal })
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe("session=test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("host")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
    expect(await response.json()).toEqual(payload);
  });

  it.each([
    401, 413, 503,
  ])("preserves Go rejection %s and its payload", async (status) => {
    const payload = { error: { message: "upload rejected" } };
    fetchMock.mockResolvedValue(Response.json(payload, { status }));
    const response = await POST(
      new Request("https://media.example.com/api/upload/presigned", {
        method: "POST",
        body: "{}",
      })
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(payload);
  });
});
