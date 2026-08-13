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
    getDetail: vi.fn(),
    getOverview: vi.fn(),
    createExport: vi.fn(),
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
vi.mock("@/features/operations-dashboard/detail-service", () => ({
  loadOperationsDetail: mocks.getDetail,
  OperationsDetailServiceError: class OperationsDetailServiceError extends Error {
    constructor(
      readonly code:
        | "validation_error"
        | "not_ready"
        | "not_implemented"
        | "invalid_data",
      message: string
    ) {
      super(message);
      this.name = "OperationsDetailServiceError";
    }
  },
}));
vi.mock("@/features/operations-dashboard/growth-service", () => ({
  OperationsGrowthServiceError: class OperationsGrowthServiceError extends Error {},
}));
vi.mock("@/features/operations-dashboard/health-adapter", () => ({
  OperationsHealthAdapterError: class OperationsHealthAdapterError extends Error {},
}));
vi.mock("@/features/operations-dashboard/export-service", () => ({
  createOperationsExport: mocks.createExport,
  listOperationsExports: vi.fn(),
  retryOperationsExport: vi.fn(),
  prepareOperationsExportDownload: vi.fn(),
  OperationsExportServiceError: class OperationsExportServiceError extends Error {},
}));
vi.mock("@/features/operations-dashboard/export-worker", () => ({
  processDatabaseOperationsExports: vi.fn(),
  expireDatabaseOperationsExports: vi.fn(),
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

const DETAIL = {
  selection: { module: "growth", detail: "users" },
  range: {},
  rows: [],
  nextCursor: null,
};

describe("operations.getOverview binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ success: true });
    mocks.getAppTimeZone.mockReturnValue("Asia/Shanghai");
    mocks.getDetail.mockResolvedValue(DETAIL);
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

  it("增长明细绑定管理员、部署时区和已规范化输入", async () => {
    await expect(
      invokeOperation(
        "operations.getDetail",
        { selection: { module: "growth", detail: "users" } },
        { type: "user", userId: "admin-1", role: "admin" }
      )
    ).resolves.toEqual(DETAIL);
    expect(mocks.getDetail).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      timeZone: "Asia/Shanghai",
      input: {
        granularity: "day",
        range: { kind: "default" },
        selection: { module: "growth", detail: "users" },
        limit: 100,
      },
    });
  });

  it("未接入的明细类型映射为稳定 not_implemented", async () => {
    const { OperationsDetailServiceError } = await import(
      "@/features/operations-dashboard/detail-service"
    );
    mocks.getDetail.mockRejectedValue(
      new OperationsDetailServiceError(
        "not_implemented",
        "detail not implemented"
      )
    );
    await expect(
      invokeOperation(
        "operations.getDetail",
        { selection: { module: "commercialization", detail: "orders" } },
        { type: "user", userId: "admin-1", role: "admin" }
      )
    ).rejects.toMatchObject({ code: "not_implemented" });
  });

  it("导出 operation 完整绑定并把管理员与筛选传给导出服务", async () => {
    for (const name of [
      "operations.createExport",
      "operations.listExports",
      "operations.retryExport",
      "operations.prepareExportDownload",
      "operations.processExports",
      "operations.expireExports",
    ]) {
      expect(isOperationBound(name)).toBe(true);
    }
    expect(isOperationBound("operations.getDetail")).toBe(true);
    mocks.createExport.mockResolvedValue({
      task: {
        id: "task-1",
        exportType: "user_growth",
        status: "queued",
        query: { granularity: "day", range: { kind: "default" } },
        createdAt: "2026-08-14T00:00:00.000Z",
        completedAt: null,
        expiresAt: null,
        rowCount: null,
        byteCount: null,
        errorCode: null,
        retryOfTaskId: null,
      },
    });
    await expect(
      invokeOperation(
        "operations.createExport",
        {
          exportType: "user_growth",
          query: {},
          clientRequestId: "request-1",
        },
        { type: "user", userId: "admin-1", role: "admin" }
      )
    ).resolves.toMatchObject({ task: { id: "task-1", status: "queued" } });
    expect(mocks.createExport).toHaveBeenCalledWith({
      createdBy: "admin-1",
      timeZone: "Asia/Shanghai",
      input: {
        exportType: "user_growth",
        query: { granularity: "day", range: { kind: "default" } },
        clientRequestId: "request-1",
      },
    });
  });
});
