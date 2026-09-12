import { describe, expect, it, vi } from "vitest";
const { requestGoJson } = vi.hoisted(() => ({ requestGoJson: vi.fn() }));
vi.mock("@/server/go-backend-client", () => ({ requestGoJson }));
vi.mock("@repo/shared/safe-action", () => ({ protectedAction: { metadata: () => ({ schema: () => ({ action: (fn: any) => fn }) }) } }));
import { refreshDataDashboardAction } from "./actions";
describe("refreshDataDashboardAction", () => {
  it("loads the atomic snapshot from Go", async () => {
    const snapshot = { marker: "snapshot" };
    requestGoJson.mockResolvedValue({ status: "ready", snapshot });
    await expect((refreshDataDashboardAction as any)({ ctx: { userId: "u" }, parsedInput: { startDate: "2026-08-01", endDate: "2026-08-09" } })).resolves.toEqual({ status: "ready", snapshot });
    expect(requestGoJson).toHaveBeenCalledWith("/api/analytics/data-dashboard", expect.objectContaining({ method: "POST" }));
  });
});
