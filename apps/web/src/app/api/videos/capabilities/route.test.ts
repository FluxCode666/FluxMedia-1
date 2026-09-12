import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyMock = vi.hoisted(() => vi.fn());
vi.mock("@/features/external-api/go-proxy", () => ({
  proxyExternalApi: proxyMock,
}));

import { GET } from "./route";

describe("GET /api/videos/capabilities", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards the first-party request to Go", async () => {
    const response = new Response(JSON.stringify({ items: [], limits: {} }), { status: 200 });
    proxyMock.mockResolvedValue(response);
    const request = new Request("https://example.com/api/videos/capabilities", {
      headers: { cookie: "better-auth.session_token=test" },
    });
    await GET(request as never);
    expect(proxyMock).toHaveBeenCalledWith(request);
  });
});
