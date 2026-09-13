import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://unit-test:unit-test@127.0.0.1:5432/unit-test";
  return { requestGoJson: vi.fn() };
});
vi.mock("@/server/go-backend-client", () => ({
  requestGoJson: mocks.requestGoJson,
}));

import { invokeOperation } from "@repo/shared/uol";
import "@repo/shared/uol/operations";
import "./credits";

describe("credits Go bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestGoJson.mockResolvedValue({
      balance: 42,
      totalSpent: 10,
      totalRefunded: 15,
      totalNetSpent: -5,
      status: "active",
      asOf: "2026-09-13T00:00:00.000Z",
    });
  });

  it("loads the current user's balance from Go and clamps legacy net totals", async () => {
    await expect(
      invokeOperation(
        "credits.getMyBalance",
        {},
        { type: "user", userId: "user-1", role: "user" }
      )
    ).resolves.toMatchObject({ balance: 42, totalNetSpent: 0 });
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/credits/balance");
  });

  it("rejects non-user principals before contacting Go", async () => {
    await expect(
      invokeOperation("credits.getMyBalance", {}, { type: "system", reason: "test" })
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(mocks.requestGoJson).not.toHaveBeenCalled();
  });
});
