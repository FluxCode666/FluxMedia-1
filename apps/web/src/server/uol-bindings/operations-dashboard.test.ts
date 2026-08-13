/**
 * 运营总览 UOL binding 的 DB-free 测试。
 *
 * 使用方：Vitest。验证人工管理员身份、部署时区、限流顺序和领域错误不会穿透
 * SQL 细节；测试替身不连接 PostgreSQL。
 */
import "@repo/shared/uol/operations";
import { invokeOperation, isOperationBound } from "@repo/shared/uol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://unit-test:unit-test@127.0.0.1:5432/unit-test";
  return {
    checkRateLimit: vi.fn(),
    getAppTimeZone: vi.fn(),
    getOverview: vi.fn(),
  };
});

vi.mock("@repo/shared/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@repo/shared/time-zone/server", () => ({
  getAppTimeZone: mocks.getAppTimeZone,
}));
vi.mock("@/features/operations-dashboard/operations-dashboard-service", () => ({
  databaseOperationsDashboardService: { getOverview: mocks.getOverview },
  OperationsDashboardServiceError: class OperationsDashboardServiceError extends Error {
    constructor(
      readonly code: "not_ready" | "invalid_data",
      message: string
    ) {
      super(message);
      this.name = "OperationsDashboardServiceError";
    }
  },
}));
vi.mock("@/features/operations-dashboard/commercial-service", () => ({
  OperationsCommercialServiceError: class OperationsCommercialServiceError extends Error {},
}));
vi.mock("@/features/operations-dashboard/content-service", () => ({
  OperationsContentServiceError: class OperationsContentServiceError extends Error {},
}));
vi.mock("@/features/operations-dashboard/growth-service", () => ({
  OperationsGrowthServiceError: class OperationsGrowthServiceError extends Error {},
}));
vi.mock("@/features/operations-dashboard/health-adapter", () => ({
  OperationsHealthAdapterError: class OperationsHealthAdapterError extends Error {},
}));

import { OperationsDashboardServiceError } from "@/features/operations-dashboard/operations-dashboard-service";
import "./operations-dashboard";

const SNAPSHOT = {
  generatedAt: "2026-08-14T00:00:00.000Z",
  timeZone: "Asia/Shanghai",
  epoch: {
    appDate: "2026-08-01",
    startsAt: "2026-07-31T16:00:00.000Z",
  },
  schemaVersion: 1,
  range: {},
  growth: {},
  commercial: {},
  content: {},
  systemHealth: {},
};

describe("operations.getOverview binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ success: true });
    mocks.getAppTimeZone.mockReturnValue("Asia/Shanghai");
    mocks.getOverview.mockResolvedValue(SNAPSHOT);
  });

  it("只允许 admin/super_admin，并把部署时区传入服务", async () => {
    await expect(
      invokeOperation(
        "operations.getOverview",
        {},
        { type: "user", userId: "admin-1", role: "admin" }
      )
    ).resolves.toEqual(SNAPSHOT);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      "operations-dashboard:admin-1",
      "global"
    );
    expect(mocks.getOverview).toHaveBeenCalledWith(
      { granularity: "day", range: { kind: "default" } },
      "Asia/Shanghai"
    );

    await expect(
      invokeOperation(
        "operations.getOverview",
        {},
        { type: "user", userId: "observer-1", role: "observer_admin" }
      )
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("限流失败发生在数据库服务之前", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false });
    await expect(
      invokeOperation(
        "operations.getOverview",
        {},
        { type: "user", userId: "admin-1", role: "super_admin" }
      )
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(mocks.getOverview).not.toHaveBeenCalled();
  });

  it("映射未就绪和损坏数据为稳定 UOL 错误", async () => {
    mocks.getOverview.mockRejectedValueOnce(
      new OperationsDashboardServiceError("not_ready", "not ready")
    );
    await expect(
      invokeOperation(
        "operations.getOverview",
        {},
        { type: "user", userId: "admin-1", role: "admin" }
      )
    ).rejects.toMatchObject({ code: "not_ready" });

    mocks.getOverview.mockRejectedValueOnce(
      new OperationsDashboardServiceError("invalid_data", "secret sql")
    );
    await expect(
      invokeOperation(
        "operations.getOverview",
        {},
        { type: "user", userId: "admin-1", role: "admin" }
      )
    ).rejects.toMatchObject({ code: "internal_error" });
  });

  it("其他 operation 在 U6 前也保持 bound 但明确返回未实现", async () => {
    for (const name of [
      "operations.getDetail",
      "operations.createExport",
      "operations.listExports",
      "operations.retryExport",
      "operations.prepareExportDownload",
      "operations.processExports",
      "operations.expireExports",
    ]) {
      expect(isOperationBound(name)).toBe(true);
    }
    await expect(
      invokeOperation(
        "operations.getDetail",
        { selection: { module: "growth", detail: "users" } },
        { type: "user", userId: "admin-1", role: "admin" }
      )
    ).rejects.toMatchObject({ code: "not_implemented" });
  });
});
