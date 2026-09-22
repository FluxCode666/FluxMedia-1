/** Go boundary regression: identity stays with the session and epoch requires system credentials. */
import "@repo/shared/uol/operations/operations-dashboard-facts";
import { invokeOperation } from "@repo/shared/uol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ requestGoJson: vi.fn() }));
vi.mock("@/server/go-backend-client", () => ({ requestGoJson: mocks.requestGoJson }));
import "./operations-dashboard-facts";

describe("operations dashboard Go fact bindings", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "test-operations-cron"); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it("web visits use the forwarded session without caller-controlled identity or date", async () => {
    mocks.requestGoJson.mockResolvedValue({ appDate: "2026-08-13", recorded: true });
    await expect(invokeOperation("operations.recordWebVisit", {}, {
      type: "user", userId: "user-1", role: "user",
    })).resolves.toEqual({ appDate: "2026-08-13", recorded: true });
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/operations/web-visit", { method: "POST", body: "{}" });
  });
  it("rejects API keys and forged input before sending the Go request", async () => {
    await expect(invokeOperation("operations.recordWebVisit", {}, {
      type: "apiKey", credentialKind: "external", userId: "user-1", apiKeyId: "key-1",
    })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(invokeOperation("operations.recordWebVisit", { userId: "other" }, {
      type: "user", userId: "user-1", role: "user",
    })).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.requestGoJson).not.toHaveBeenCalled();
  });
  it("epoch forwards deployment identity with the dedicated credential", async () => {
    mocks.requestGoJson.mockResolvedValue({ appDate: "2026-08-16", startsAt: "2026-08-15T16:00:00.000Z", initialized: true });
    await expect(invokeOperation("operations.ensureCurrentEpoch", { initializedBy: "release-v1" }, {
      type: "system", reason: "deployment",
    })).resolves.toMatchObject({ initialized: true });
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/operations/ensure-epoch", {
      method: "POST", headers: { authorization: "Bearer test-operations-cron" }, body: '{"initializedBy":"release-v1"}',
    });
    await expect(invokeOperation("operations.ensureCurrentEpoch", { initializedBy: "release-v1" }, {
      type: "user", userId: "admin-1", role: "super_admin",
    })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("epoch fails closed when its service credential is absent", async () => {
    vi.stubEnv("CRON_SECRET", "");
    await expect(invokeOperation("operations.ensureCurrentEpoch", { initializedBy: "release-v1" }, {
      type: "system", reason: "deployment",
    })).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.requestGoJson).not.toHaveBeenCalled();
  });
});
