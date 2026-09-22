import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("../http/go-backend", () => ({ requestGoBackendJson: request }));

import { mediaLimitService } from "./media-limit-service";

describe("Go media limit facade", () => {
  beforeEach(() => request.mockReset());

  it("forwards the request identity and returns the persisted audit timestamp", async () => {
    request.mockResolvedValue({
      changed: true,
      before: null,
      after: 40,
      effectiveConcurrency: 40,
      effectiveSource: "user_override",
      auditLogId: "persisted-audit",
      updatedAt: "2026-09-13T12:34:56.123Z",
    });
    const result = await mediaLimitService.setUserConcurrencyOverride({
      actor: { userId: "actor", role: "admin" },
      userId: "target",
      override: 40,
      reason: "capacity",
      requestId: "original-request",
    });
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/api/admin/users/target/concurrency");
    expect(new Headers(init.headers).get("X-Request-ID")).toBe("original-request");
    expect(JSON.parse(init.body)).toEqual({ userId: "target", override: 40, reason: "capacity" });
    expect(result.auditLogId).toBe("persisted-audit");
    expect(result.updatedAt).toEqual(new Date("2026-09-13T12:34:56.123Z"));
  });
});
