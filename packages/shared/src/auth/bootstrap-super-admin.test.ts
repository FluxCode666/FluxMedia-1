import { beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../http/go-backend", () => ({ requestGoBackendInternalJson: request }));
import { bootstrapSelfUseSuperAdmin } from "./bootstrap-super-admin";

describe("Go administrator bootstrap boundary", () => {
  beforeEach(() => request.mockReset());
  it("returns the persisted user identity without forwarding deployment credentials", async () => {
    request.mockResolvedValue({ userId: "actual-admin", success: true });
    await expect(bootstrapSelfUseSuperAdmin()).resolves.toEqual({ userId: "actual-admin", success: true });
    expect(request).toHaveBeenCalledWith("/api/internal/auth/bootstrap", { method: "POST" });
  });
  it("preserves a skipped bootstrap and retries later through Go", async () => {
    request.mockResolvedValueOnce({ userId: "", success: false, reason: "credentials_not_configured" })
      .mockResolvedValueOnce({ userId: "actual-admin", success: true });
    await expect(bootstrapSelfUseSuperAdmin()).resolves.toMatchObject({ userId: "", success: false });
    await expect(bootstrapSelfUseSuperAdmin()).resolves.toMatchObject({ userId: "actual-admin", success: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
