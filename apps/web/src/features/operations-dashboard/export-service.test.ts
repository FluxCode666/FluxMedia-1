/**
 * 运营导出应用服务 DB-free 测试。
 *
 * 使用方：U6。验证创建者幂等委托、失败父任务重试、列表 cursor 跨管理员拒绝和
 * 七天下载边界；真实 PostgreSQL 状态迁移由仓储 SQL 测试覆盖。
 */
import type { OperationsExportTask } from "@repo/database/schema";
import { describe, expect, it, vi } from "vitest";

import {
  createOperationsExport,
  getOperationsExportDownloadTarget,
  listOperationsExports,
  OperationsExportServiceError,
  retryOperationsExport,
} from "./export-service";
import type { OperationsExportTaskRepository } from "./export-task-repository";

const now = new Date("2026-08-14T00:00:00.000Z");

/** 构造最小任务行。 */
function task(
  overrides: Partial<OperationsExportTask> = {}
): OperationsExportTask {
  return {
    id: "task-1",
    createdBy: "admin-1",
    clientRequestId: "request-1",
    exportType: "user_growth",
    status: "queued",
    query: {
      granularity: "day",
      range: { kind: "custom", from: "2026-08-01", to: "2026-08-14" },
    },
    timeZone: "UTC",
    epochAppDate: "2026-01-01",
    epochStartsAt: new Date("2026-01-01T00:00:00.000Z"),
    schemaVersion: 1,
    snapshotAt: now,
    highWatermarks: {},
    retryOfTaskId: null,
    attemptCount: 0,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    objectBucket: null,
    objectKey: null,
    checksumSha256: null,
    rowCount: null,
    byteCount: null,
    errorCode: null,
    completedAt: null,
    expiresAt: null,
    objectDeletedAt: null,
    cleanupErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 创建默认仓储替身。 */
function repository(): OperationsExportTaskRepository {
  return {
    create: vi.fn().mockResolvedValue(task()),
    list: vi.fn().mockResolvedValue([]),
    findOwned: vi.fn().mockResolvedValue(null),
    findDownloadable: vi.fn().mockResolvedValue(null),
    recordDownload: vi.fn(),
    claimNext: vi.fn(),
    renewLease: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    recordOrphan: vi.fn(),
    listOrphans: vi.fn(),
    markOrphanDeleted: vi.fn(),
    expireDue: vi.fn(),
    markDeleted: vi.fn(),
    markCleanupFailed: vi.fn(),
  };
}

describe("operations export service", () => {
  it("创建时把创建者、clientRequestId、配额和原查询委托给事务仓储", async () => {
    const repo = repository();
    await createOperationsExport(
      {
        createdBy: "admin-1",
        timeZone: "UTC",
        input: {
          exportType: "user_growth",
          query: {},
          clientRequestId: "request-1",
        },
      },
      {
        repository: repo,
        now: () => now,
        createId: () => "task-1",
        tokenSecret: "secret",
      }
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBy: "admin-1",
        clientRequestId: "request-1",
        perAdminLimit: 3,
        globalLimit: 100,
        query: { granularity: "day", range: { kind: "default" } },
      })
    );
  });

  it("重试只接受自己的 failed 父任务并保留 retryOfTaskId", async () => {
    const repo = repository();
    vi.mocked(repo.findOwned).mockResolvedValue(task({ status: "failed" }));
    vi.mocked(repo.create).mockResolvedValue(
      task({
        id: "task-2",
        clientRequestId: "retry-1",
        retryOfTaskId: "task-1",
      })
    );
    await retryOperationsExport(
      {
        createdBy: "admin-1",
        input: { taskId: "task-1", clientRequestId: "retry-1" },
      },
      {
        repository: repo,
        now: () => now,
        createId: () => "task-2",
        tokenSecret: "secret",
      }
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        retryOfTaskId: "task-1",
        clientRequestId: "retry-1",
      })
    );
  });

  it("重试命中频率限制时返回稳定可恢复错误", async () => {
    const repo = repository();
    vi.mocked(repo.findOwned).mockResolvedValue(task({ status: "failed" }));
    vi.mocked(repo.create).mockRejectedValue(
      new Error("operations_export_rate_limited")
    );

    await expect(
      retryOperationsExport(
        {
          createdBy: "admin-1",
          input: { taskId: "task-1", clientRequestId: "retry-1" },
        },
        {
          repository: repo,
          now: () => now,
          createId: () => "task-2",
          tokenSecret: "secret",
        }
      )
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("列表 cursor 绑定管理员，不能被另一管理员复用", async () => {
    const repo = repository();
    vi.mocked(repo.list).mockResolvedValue([
      task(),
      task({ id: "task-0", createdAt: new Date(now.getTime() - 1) }),
    ]);
    const first = await listOperationsExports(
      { createdBy: "admin-1", input: { limit: 1 } },
      {
        repository: repo,
        now: () => now,
        createId: () => "unused",
        tokenSecret: "secret",
      }
    );
    await expect(
      listOperationsExports(
        { createdBy: "admin-2", input: { limit: 1, cursor: first.nextCursor } },
        {
          repository: repo,
          now: () => now,
          createId: () => "unused",
          tokenSecret: "secret",
        }
      )
    ).rejects.toBeInstanceOf(OperationsExportServiceError);
  });

  it("下载在到期前允许，在边界时拒绝，并始终绑定当前管理员", async () => {
    const repo = repository();
    const expiresAt = new Date("2026-08-21T00:00:00.000Z");
    vi.mocked(repo.findDownloadable).mockImplementation(
      async (_taskId, createdBy, requestedAt) => {
        if (createdBy !== "admin-1" || requestedAt >= expiresAt) return null;
        return {
          id: "task-1",
          createdBy,
          status: "completed",
          objectBucket: "exports",
          objectKey: "task-1.csv",
          expiresAt,
          exportType: "user_growth",
        };
      }
    );

    await expect(
      getOperationsExportDownloadTarget(
        {
          taskId: "task-1",
          createdBy: "admin-1",
          now: new Date(expiresAt.getTime() - 1),
        },
        repo
      )
    ).resolves.toMatchObject({ id: "task-1" });
    await expect(
      getOperationsExportDownloadTarget(
        { taskId: "task-1", createdBy: "admin-1", now: expiresAt },
        repo
      )
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      getOperationsExportDownloadTarget(
        {
          taskId: "task-1",
          createdBy: "admin-2",
          now: new Date(expiresAt.getTime() - 1),
        },
        repo
      )
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
