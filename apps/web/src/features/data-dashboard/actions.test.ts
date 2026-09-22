import { describe, expect, it, vi } from "vitest";

const { requestGoJson } = vi.hoisted(() => ({ requestGoJson: vi.fn() }));
vi.mock("@/server/go-backend-client", () => ({ requestGoJson }));
vi.mock("@repo/shared/safe-action", () => ({
  protectedAction: {
    metadata: () => ({
      schema: () => ({ action: <T,>(handler: T) => handler }),
    }),
  },
}));
import { refreshDataDashboardAction } from "./actions";

describe("refreshDataDashboardAction", () => {
  it("loads the atomic snapshot from Go", async () => {
    const snapshot = { marker: "snapshot" };
    requestGoJson.mockResolvedValue({ status: "ready", snapshot });
    const invoke = refreshDataDashboardAction as unknown as (input: {
      ctx: { userId: string };
      parsedInput: { startDate: string; endDate: string };
    }) => Promise<unknown>;
    await expect(
      invoke({
        ctx: { userId: "u" },
        parsedInput: { startDate: "2026-08-01", endDate: "2026-08-09" },
      })
    ).resolves.toEqual({ status: "ready", snapshot });
    expect(requestGoJson).toHaveBeenCalledWith(
      "/api/analytics/data-dashboard",
      expect.objectContaining({ method: "POST" })
    );
  });
});
