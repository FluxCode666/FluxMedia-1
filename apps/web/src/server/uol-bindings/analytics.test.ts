/** Analytics UOL bindings are thin, authenticated adapters over the Go API. */
import "@repo/shared/uol/operations";
import { invokeOperation, isOperationBound } from "@repo/shared/uol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://unit-test:unit-test@127.0.0.1:5432/unit-test";
  return { requestGoJson: vi.fn() };
});
vi.mock("@/server/go-backend-client", () => ({ requestGoJson: mocks.requestGoJson, GoBackendRequestError: class GoBackendRequestError extends Error { constructor(message:string,readonly status:number,readonly code?:string){super(message)} } }));
import {GoBackendRequestError} from "@/server/go-backend-client";
import "./analytics";

const SNAPSHOT = {
  asOf: "2026-08-09T10:15:30.000Z", timeZone: "Asia/Shanghai", today: "2026-08-09",
  range: { startDate: "2026-08-09", endDate: "2026-08-09", start: "2026-08-08T16:00:00.000Z", end: "2026-08-09T10:15:30.000Z" },
  metrics: { imageCount: 1, videoSeconds: 0, creditsConsumed: 2, successRate: { succeeded: 1, failed: 0, terminal: 1, rate: 1 }, activeDays: 1, mostUsedModel: { model: "image-model", taskCount: 1 } },
  buckets: [{ date: "2026-08-09", start: "2026-08-08T16:00:00.000Z", end: "2026-08-09T10:15:30.000Z", imageCount: 1, imageTaskCount: 1, videoCount: 0, videoSeconds: 0, creditsConsumed: 2 }],
  taskComposition: { imageTaskCount: 1, videoCount: 0, totalTasks: 1 },
} as const;
const SUMMARY = {
  asOf: "2026-08-09T10:15:30.000Z", timeZone: "Asia/Shanghai", last24HoursRange: { start: "2026-08-08T10:15:30.000Z", end: "2026-08-09T10:15:30.000Z" },
  last24Hours: { imageCount: 1, videoSeconds: 0, creditsConsumed: 2 }, modelDistribution: { models: [{ model: "image-model", taskCount: 1 }], totalTasks: 1 }, lifetime: { imageCount: 2, videoSeconds: 3, creditsConsumed: 4 },
};
const TRENDS = {
  asOf: "2026-08-09T10:15:30.000Z", timeZone: "Asia/Shanghai", range: { start: "2026-08-08T10:15:30.000Z", end: "2026-08-09T10:15:30.000Z" }, granularity: "hour", metric: "imageCount", unit: "images",
  buckets: [{ start: "2026-08-08T10:15:30.000Z", end: "2026-08-08T11:15:30.000Z", label: "2026-08-08 18:15", value: 1 }], distribution: { imageTasks: 1, videoTasks: 0, totalTasks: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestGoJson.mockImplementation(async (path: string) => {
    if (path === "/api/analytics/summary") return SUMMARY;
    if (path === "/api/analytics/trends") return TRENDS;
    if (path.startsWith("/api/admin/analytics/users")) return { users: [{ id: "user-1", name: "张三", email: "zhang@example.com" }] };
    return { status: "ready", snapshot: SNAPSHOT };
  });
});

describe("analytics Go bindings", () => {
  it("keeps all five operations bound", () => {
    for (const name of ["analytics.getMyDataDashboard", "analytics.getAdminDataDashboard", "analytics.searchAdminDataDashboardUsers", "analytics.getMyUsageSummary", "analytics.getMyUsageTrends"]) expect(isOperationBound(name)).toBe(true);
  });
  it("calls Go for the user dashboard and derives scope from the session", async () => {
    await expect(invokeOperation("analytics.getMyDataDashboard", { startDate: "2026-08-09", endDate: "2026-08-09" }, { type: "user", userId: "user-1", role: "user" })).resolves.toEqual(SNAPSHOT);
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/analytics/data-dashboard", { method: "POST", body: JSON.stringify({ startDate: "2026-08-09", endDate: "2026-08-09" }) });
  });
  it("rejects non-session principals before touching Go", async () => {
    await expect(invokeOperation("analytics.getMyDataDashboard", {}, { type: "apiKey", credentialKind: "external", userId: "user-1", apiKeyId: "key-1" })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(mocks.requestGoJson).not.toHaveBeenCalled();
  });
  it("calls Go for admin dashboard and preserves selected user input", async () => {
    await expect(invokeOperation("analytics.getAdminDataDashboard", { userId: "target-user", startDate: "2026-08-03", endDate: "2026-08-09" }, { type: "user", userId: "admin-1", role: "admin" })).resolves.toEqual(SNAPSHOT);
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/admin/analytics/data-dashboard", { method: "POST", body: JSON.stringify({ startDate: "2026-08-03", endDate: "2026-08-09", userId: "target-user" }) });
  });
  it("enforces admin permission before admin Go calls", async () => {
    await expect(invokeOperation("analytics.getAdminDataDashboard", {}, { type: "user", userId: "user-1", role: "user" })).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.requestGoJson).not.toHaveBeenCalled();
  });
  it("calls Go for bounded admin user search", async () => {
    await expect(invokeOperation("analytics.searchAdminDataDashboardUsers", { query: "张", limit: 20 }, { type: "user", userId: "admin-1", role: "super_admin" })).resolves.toEqual({ users: [{ id: "user-1", name: "张三", email: "zhang@example.com" }] });
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/admin/analytics/users?query=%E5%BC%A0&limit=20");
  });
  it("routes summary and trends to Go and validates their response contracts", async () => {
    await expect(invokeOperation("analytics.getMyUsageSummary", {}, { type: "user", userId: "user-1", role: "user" })).resolves.toEqual(SUMMARY);
    await expect(invokeOperation("analytics.getMyUsageTrends", { granularity: "hour", range: "last24Hours" }, { type: "user", userId: "user-1", role: "user" })).resolves.toEqual(TRENDS);
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/analytics/summary");
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/analytics/trends", { method: "POST", body: JSON.stringify({ granularity: "hour", metric: "imageCount", range: "last24Hours" }) });
  });
  it("preserves Go rate limit rejection", async () => {
    mocks.requestGoJson.mockRejectedValue(new GoBackendRequestError("Too frequent",429,"RATE_LIMITED"));
    await expect(invokeOperation("analytics.getMyDataDashboard", {}, { type: "user", userId: "user-1", role: "user" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(mocks.requestGoJson).toHaveBeenCalledTimes(1);
  });
});
