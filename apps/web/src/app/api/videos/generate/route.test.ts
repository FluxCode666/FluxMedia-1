import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyMock = vi.hoisted(() => vi.fn());
vi.mock("@/features/external-api/go-proxy", () => ({
  proxyExternalApi: proxyMock,
}));

import { POST } from "./route";

describe("POST /api/videos/generate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards JSON, session cookie, and request headers to Go", async () => {
    const response = new Response(JSON.stringify({ taskId: "video-1" }), { status: 202 });
    proxyMock.mockResolvedValue(response);
    const request = new Request("https://example.com/api/videos/generate", {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=test",
        origin: "https://example.com",
        "x-request-id": "request-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientRequestId: "request-1",
        prompt: "海边日落",
        model: "seedance2",
        duration: 8,
        aspectRatio: "16:9",
        resolution: "720p",
      }),
    });
    const actual = await POST(request as never);
    expect(actual).toBe(response);
    expect(proxyMock).toHaveBeenCalledWith(request);
  });
});
