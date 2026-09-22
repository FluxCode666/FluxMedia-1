import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyExternalApi: vi.fn() }));
vi.mock("@/features/external-api/go-proxy", () => ({
  proxyExternalApi: mocks.proxyExternalApi,
}));

import { GET } from "./route";

describe("GET /r/[code]", () => {
  it("forwards referral short links to the Go backend", async () => {
    const request = new Request("https://app.example.com/r/ABC123", {
      headers: { cookie: "NEXT_LOCALE=en" },
    });
    const response = Response.redirect("https://app.example.com/en/sign-up", 303);
    mocks.proxyExternalApi.mockResolvedValueOnce(response);

    await expect(GET(request)).resolves.toBe(response);
    expect(mocks.proxyExternalApi).toHaveBeenCalledWith(request);
  });
});
