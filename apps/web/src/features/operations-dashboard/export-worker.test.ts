/**
 * 运营 CSV worker 状态机单元测试。
 *
 * 使用方：U6 worker。以可注入仓储和存储验证 fencing、上传失败、完成 CAS 失败与
 * 孤儿清理，不依赖 PostgreSQL 或真实对象存储。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/shared/logger", () => ({
  logger: {
    info: loggerMocks.info,
    warn: loggerMocks.warn,
  },
  logError: loggerMocks.logError,
}));

import {
  expireOperationsExportBatch,
  formatOperationsExportAmount,
  formatOperationsExportDateTime,
  type OperationsExportCleanupDependencies,
  type OperationsExportWorkerDependencies,
  processOperationsExportBatch,
} from "./export-worker";

const task = {
  id: "task-1",
  createdBy: "admin-1",
  exportType: "content_production" as const,
  query: { granularity: "day" as const, range: { kind: "default" as const } },
  timeZone: "UTC",
  epochAppDate: "2026-01-01",
  epochStartsAt: new Date("2026-01-01T00:00:00.000Z"),
  schemaVersion: 1,
  snapshotAt: new Date("2026-02-01T00:00:00.000Z"),
  highWatermarks: { databaseSnapshot: "1:2:" },
  leaseOwner: "worker-1",
  leaseToken: "lease-1",
  attemptCount: 1,
};

/** 创建 happy-path fake，单项测试只覆盖需要改变的端口。 */
function createDependencies(): OperationsExportWorkerDependencies {
  return {
    repository: {
      claimNext: vi.fn().mockResolvedValue(task),
      renewLease: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
      recordOrphan: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      bucket: "exports",
      putObjectStream: vi.fn(async (_key, _bucket, data) => {
        for await (const _chunk of data) {
          // 消费完整流模拟 provider 上传。
        }
      }),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    },
    createRows: () =>
      (async function* () {
        yield [
          "task-1",
          "user-1",
          "model-1",
          "image",
          "2026-02-01T00:00:00.000Z",
          "completed",
          1,
          0,
          "1.00",
        ];
      })(),
    now: () => new Date("2026-02-01T00:00:01.000Z"),
    createToken: () => "lease-1",
  };
}

describe("processOperationsExportBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("空导出仍完成并记录零业务行", async () => {
    const dependencies = createDependencies();
    dependencies.createRows = () =>
      (async function* () {
        // 空异步生成器仍会让编码器输出 BOM 和表头。
      })();

    await processOperationsExportBatch(
      { limit: 1, workerId: "worker-1" },
      dependencies
    );

    expect(dependencies.repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({ rowCount: 0 })
    );
  });

  it("流式上传后只以相同 lease token 完成任务", async () => {
    const dependencies = createDependencies();
    await expect(
      processOperationsExportBatch(
        { limit: 1, workerId: "worker-1" },
        dependencies
      )
    ).resolves.toEqual({ processed: 1 });
    expect(dependencies.repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        leaseToken: "lease-1",
        rowCount: 1,
        expiresAt: new Date("2026-02-08T00:00:01.000Z"),
      })
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "operations.processExports",
        exportTaskId: "task-1",
        attempt: 1,
        leaseStatus: "completed",
        rowCount: 1,
        byteCount: expect.any(Number),
        durationMs: expect.any(Number),
      }),
      "Operations export task completed"
    );
  });

  it("完成 CAS 失败时删除上传对象，删除失败则登记孤儿", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.repository.complete).mockResolvedValue(false);
    vi.mocked(dependencies.storage.deleteObject).mockRejectedValue(
      new Error("storage unavailable")
    );

    await processOperationsExportBatch(
      { limit: 1, workerId: "worker-1" },
      dependencies
    );

    expect(dependencies.repository.recordOrphan).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", leaseToken: "lease-1" })
    );
  });

  it("数据库完成写结果不确定时不删除可能已发布的对象", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.repository.complete).mockRejectedValue(
      new Error("database unavailable")
    );
    await processOperationsExportBatch(
      { limit: 1, workerId: "worker-1" },
      dependencies
    );
    expect(dependencies.repository.recordOrphan).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        errorCode: "completion_result_unknown",
      })
    );
    expect(dependencies.storage.deleteObject).not.toHaveBeenCalled();
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
  });

  it("上传失败时以 fencing token 标记失败且不伪造完成", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.storage.putObjectStream).mockRejectedValue(
      new Error("upload failed")
    );
    await processOperationsExportBatch(
      { limit: 1, workerId: "worker-1" },
      dependencies
    );
    expect(dependencies.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", leaseToken: "lease-1" })
    );
    expect(dependencies.repository.complete).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "operations.processExports",
        exportTaskId: "task-1",
        attempt: 1,
        leaseStatus: "failed",
        errorCode: "export_failed",
        durationMs: expect.any(Number),
      }),
      "Operations export task failed"
    );
  });

  it("上传响应不确定且对象删除失败时登记孤儿候选", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.storage.putObjectStream).mockRejectedValue(
      new Error("upload response lost")
    );
    vi.mocked(dependencies.storage.deleteObject).mockRejectedValue(
      new Error("storage unavailable")
    );

    await processOperationsExportBatch(
      { limit: 1, workerId: "worker-1" },
      dependencies
    );

    expect(dependencies.repository.recordOrphan).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        errorCode: "orphan_delete_failed",
      })
    );
    expect(dependencies.repository.fail).toHaveBeenCalled();
  });

  it("慢上传期间独立续租，失租后通过 AbortSignal 中止存储写入", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.repository.renewLease)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    dependencies.leaseRenewIntervalMs = 1;
    vi.mocked(dependencies.storage.putObjectStream).mockImplementation(
      async (_key, _bucket, _data, _contentType, options) => {
        await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true }
          );
        });
      }
    );

    await processOperationsExportBatch(
      { limit: 1, workerId: "worker-1" },
      dependencies
    );

    expect(dependencies.repository.renewLease).toHaveBeenCalledTimes(2);
    expect(dependencies.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", leaseToken: "lease-1" })
    );
    expect(dependencies.repository.complete).not.toHaveBeenCalled();
  });
});

describe("operations export formatting", () => {
  it("按币种最小单位固定金额小数位", () => {
    expect(formatOperationsExportAmount(1_230, "CNY")).toBe("12.30");
    expect(formatOperationsExportAmount(1_230, "JPY")).toBe("1230");
    expect(formatOperationsExportAmount(1_230, "KWD")).toBe("1.230");
  });

  it("跨 DST 边界导出真实应用时区偏移", () => {
    expect(
      formatOperationsExportDateTime(
        new Date("2026-03-08T06:59:59.123Z"),
        "America/New_York"
      )
    ).toBe("2026-03-08T01:59:59.123-05:00");
    expect(
      formatOperationsExportDateTime(
        new Date("2026-03-08T07:00:00.123Z"),
        "America/New_York"
      )
    ).toBe("2026-03-08T03:00:00.123-04:00");
  });
});

/** 创建过期与孤儿清理的最小可替换依赖。 */
function createCleanupDependencies(): OperationsExportCleanupDependencies {
  return {
    repository: {
      expireDue: vi.fn().mockResolvedValue([]),
      markDeleted: vi.fn().mockResolvedValue(undefined),
      markCleanupFailed: vi.fn().mockResolvedValue(undefined),
      listOrphans: vi.fn().mockResolvedValue([]),
      markOrphanDeleted: vi.fn().mockResolvedValue(undefined),
      findReferencedObjectKeys: vi.fn().mockResolvedValue(new Set()),
      findActiveExportLeases: vi.fn().mockResolvedValue([]),
    },
    storage: {
      bucket: "exports",
      deleteObject: vi.fn().mockResolvedValue(undefined),
      listObjects: vi.fn().mockResolvedValue({
        objects: [],
        nextCursor: null,
      }),
      listMultipartUploads: vi.fn().mockResolvedValue({
        uploads: [],
        nextCursor: null,
      }),
      abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
    },
    now: () => new Date("2026-02-08T00:00:01.000Z"),
  };
}

describe("expireOperationsExportBatch", () => {
  it("过期对象删除失败后保留记录，并在下一批重试成功", async () => {
    const dependencies = createCleanupDependencies();
    vi.mocked(dependencies.repository.expireDue).mockResolvedValue([
      { id: "task-1", objectBucket: "exports", objectKey: "task-1.csv" },
    ]);
    vi.mocked(dependencies.storage.deleteObject)
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);

    await expireOperationsExportBatch({ limit: 1 }, dependencies);
    expect(dependencies.repository.markCleanupFailed).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" })
    );
    expect(dependencies.repository.markDeleted).not.toHaveBeenCalled();

    await expireOperationsExportBatch({ limit: 1 }, dependencies);
    expect(dependencies.repository.markDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", objectKey: "task-1.csv" })
    );
  });

  it("重扫未完成的孤儿审计并在删除后写完成水位", async () => {
    const dependencies = createCleanupDependencies();
    vi.mocked(dependencies.repository.listOrphans).mockResolvedValue([
      {
        auditId: "audit-1",
        taskId: "task-stale",
        objectBucket: "exports",
        objectKey: "stale.csv",
      },
    ]);

    await expect(
      expireOperationsExportBatch({ limit: 1 }, dependencies)
    ).resolves.toEqual({ processed: 1 });
    expect(dependencies.storage.deleteObject).toHaveBeenCalledWith(
      "stale.csv",
      "exports"
    );
    expect(dependencies.repository.markOrphanDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: "audit-1", taskId: "task-stale" })
    );
  });

  it("存储扫描保留任务引用对象与年轻对象，只删除陈旧未引用对象", async () => {
    const dependencies = createCleanupDependencies();
    vi.mocked(dependencies.storage.listObjects).mockResolvedValue({
      objects: [
        {
          key: "operations-exports/task-completed/lease.csv",
          lastModified: new Date("2026-02-01T00:00:00.000Z"),
        },
        {
          key: "operations-exports/task-expired/lease.csv",
          lastModified: new Date("2026-02-01T00:00:00.000Z"),
        },
        {
          key: "operations-exports/task-active/lease-active.csv.random.tmp",
          lastModified: new Date("2026-02-01T00:00:00.000Z"),
        },
        {
          key: "operations-exports/task-young/lease.csv.random.tmp",
          lastModified: new Date("2026-02-07T23:59:00.000Z"),
        },
        {
          key: "operations-exports/task-orphan/lease.csv",
          lastModified: new Date("2026-02-01T00:00:00.000Z"),
        },
      ],
      nextCursor: "next-page",
    });
    vi.mocked(
      dependencies.repository.findReferencedObjectKeys
    ).mockResolvedValue(
      new Set([
        "operations-exports/task-completed/lease.csv",
        "operations-exports/task-expired/lease.csv",
      ])
    );
    vi.mocked(dependencies.repository.findActiveExportLeases).mockResolvedValue(
      [{ taskId: "task-active", leaseToken: "lease-active" }]
    );

    await expireOperationsExportBatch({ limit: 10 }, dependencies);

    expect(
      dependencies.repository.findReferencedObjectKeys
    ).toHaveBeenCalledWith({
      objectBucket: "exports",
      objectKeys: expect.arrayContaining([
        "operations-exports/task-completed/lease.csv",
        "operations-exports/task-expired/lease.csv",
        "operations-exports/task-orphan/lease.csv",
      ]),
    });
    expect(dependencies.storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(dependencies.storage.deleteObject).toHaveBeenCalledWith(
      "operations-exports/task-orphan/lease.csv",
      "exports"
    );
  });

  it("存储孤儿删除失败可重试，且不阻止到期任务保持 expired", async () => {
    const dependencies = createCleanupDependencies();
    vi.mocked(dependencies.repository.expireDue).mockResolvedValue([
      { id: "task-expired", objectBucket: "exports", objectKey: "expired.csv" },
    ]);
    vi.mocked(dependencies.storage.listObjects).mockResolvedValue({
      objects: [
        {
          key: "operations-exports/task-orphan/lease.csv",
          lastModified: new Date("2026-02-01T00:00:00.000Z"),
        },
      ],
      nextCursor: null,
    });
    vi.mocked(dependencies.storage.deleteObject)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue(undefined);

    await expireOperationsExportBatch({ limit: 10 }, dependencies);
    await expireOperationsExportBatch({ limit: 10 }, dependencies);

    expect(dependencies.repository.markDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-expired" })
    );
    expect(dependencies.storage.deleteObject).toHaveBeenCalledWith(
      "operations-exports/task-orphan/lease.csv",
      "exports"
    );
  });

  it("陈旧 multipart 只终止失效 lease，仍活跃的长上传保持不变", async () => {
    const dependencies = createCleanupDependencies();
    const listMultipartUploads = dependencies.storage.listMultipartUploads;
    const abortMultipartUpload = dependencies.storage.abortMultipartUpload;
    if (!listMultipartUploads || !abortMultipartUpload) {
      throw new Error("multipart cleanup test capabilities missing");
    }
    vi.mocked(listMultipartUploads).mockResolvedValue({
      uploads: [
        {
          key: "operations-exports/task-active/lease-active.csv",
          initiatedAt: new Date("2026-02-01T00:00:00.000Z"),
          cleanupToken: "upload-active",
        },
        {
          key: "operations-exports/task-stale/lease-stale.csv",
          initiatedAt: new Date("2026-02-01T00:00:00.000Z"),
          cleanupToken: "upload-stale",
        },
      ],
      nextCursor: null,
    });
    vi.mocked(dependencies.repository.findActiveExportLeases).mockResolvedValue(
      [{ taskId: "task-active", leaseToken: "lease-active" }]
    );

    await expireOperationsExportBatch({ limit: 10 }, dependencies);

    expect(abortMultipartUpload).toHaveBeenCalledTimes(1);
    expect(abortMultipartUpload).toHaveBeenCalledWith(
      "operations-exports/task-stale/lease-stale.csv",
      "exports",
      "upload-stale"
    );
  });
});
