import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyExternalApi: vi.fn() }));
vi.mock("@/features/external-api/go-proxy", () => ({
  proxyExternalApi: mocks.proxyExternalApi,
}));

import { POST } from "./route";

describe("POST /api/admin/site-branding/logo", () => {
  it("forwards the multipart request to the Go backend", async () => {
    const request = new Request("https://app.example.com/api/admin/site-branding/logo", {
      method: "POST",
      body: new FormData(),
    });
    const response = Response.json({ logoUrl: "/api/storage/system/logo/hash.svg", replayed: false });
    mocks.proxyExternalApi.mockResolvedValueOnce(response);
    await expect(POST(request)).resolves.toBe(response);
    expect(mocks.proxyExternalApi).toHaveBeenCalledWith(request);
  });
});
