/**
 * 运营导出下载路由权限与流式响应测试。
 *
 * 使用方：Vitest。验证匿名、普通用户、他人任务与本地流式下载边界。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getRole: vi.fn(),
  getTarget: vi.fn(),
  getStorage: vi.fn(),
  recordDownload: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getRole,
}));
vi.mock("@repo/shared/logger", () => ({ logError: mocks.logError }));
vi.mock("@/features/operations-dashboard/export-service", async () => {
  class OperationsExportServiceError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
    }
  }
  return {
    getOperationsExportDownloadTarget: mocks.getTarget,
    OperationsExportServiceError,
  };
});
vi.mock("@/features/operations-dashboard/export-storage", () => ({
  getOperationsExportStorage: mocks.getStorage,
}));
vi.mock("@/features/operations-dashboard/export-task-repository", () => ({
  databaseOperationsExportTaskRepository: {
    recordDownload: mocks.recordDownload,
  },
}));

import { GET } from "./route";

/** 调用动态路由。 */
function call() {
  return GET(
    new Request(
      "http://localhost/api/admin/operations/exports/task-1/download"
    ) as never,
    { params: Promise.resolve({ taskId: "task-1" }) }
  );
}

describe("operations export download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "admin-1" } });
    mocks.getRole.mockResolvedValue("admin");
    mocks.getTarget.mockResolvedValue({
      id: "task-1",
      exportType: "user_growth",
      objectKey: "key.csv",
      objectBucket: "exports",
    });
    mocks.recordDownload.mockResolvedValue(undefined);
    mocks.getStorage.mockResolvedValue({
      remote: false,
      getObjectStream: vi.fn().mockResolvedValue(
        (async function* () {
          yield Buffer.from("a,b\r\n");
        })()
      ),
    });
  });

  it("拒绝匿名和普通用户", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    mocks.getRole.mockResolvedValueOnce("user");
    expect((await call()).status).toBe(403);
  });

  it("流式返回本地 CSV 并记录开始审计", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("task-1.csv");
    await expect(response.text()).resolves.toBe("a,b\r\n");
    expect(mocks.getTarget).toHaveBeenCalledWith({
      taskId: "task-1",
      createdBy: "admin-1",
    });
    expect(mocks.recordDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        createdBy: "admin-1",
        result: "started",
      })
    );
  });

  it("对象读取失败时记录存储不可用审计", async () => {
    vi.mocked(mocks.getStorage).mockResolvedValueOnce({
      remote: false,
      getObjectStream: vi.fn().mockRejectedValue(new Error("storage down")),
    });
    expect((await call()).status).toBe(503);
    expect(mocks.recordDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        result: "storage_unavailable",
      })
    );
  });
});
