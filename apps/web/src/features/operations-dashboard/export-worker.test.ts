/**
 * 运营 CSV worker 状态机单元测试。
 *
 * 使用方：U6 worker。以可注入仓储和存储验证 fencing、上传失败、完成 CAS 失败与
 * 孤儿清理，不依赖 PostgreSQL 或真实对象存储。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationsGrowthDetailRepository } from "./detail-repository";

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
  buildOperationsExportQuerySpecs,
  expireOperationsExportBatch,
  formatOperationsExportAmount,
  formatOperationsExportDateTime,
  OPERATIONS_EXPORT_MAX_ATTEMPTS,
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

  it("崩溃重领超过上限后直接失败且不再生成对象", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.repository.claimNext).mockResolvedValue({
      ...task,
      highWatermarks: {
        users: null,
        webVisits: null,
        outputs: null,
        paymentOrders: null,
        paymentLifecycle: null,
        creditContributions: null,
      },
      attemptCount: OPERATIONS_EXPORT_MAX_ATTEMPTS + 1,
    });

    await expect(
      processOperationsExportBatch(
        { limit: 1, workerId: "worker-1" },
        dependencies
      )
    ).resolves.toEqual({ processed: 1 });

    expect(dependencies.repository.fail).toHaveBeenCalledWith({
      taskId: task.id,
      leaseToken: task.leaseToken,
      errorCode: "max_attempts_exceeded",
      now: new Date("2026-02-01T00:00:01.000Z"),
    });
    expect(dependencies.storage.putObjectStream).not.toHaveBeenCalled();
    expect(dependencies.repository.complete).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: OPERATIONS_EXPORT_MAX_ATTEMPTS + 1,
        leaseStatus: "failed",
        errorCode: "max_attempts_exceeded",
      }),
      "Operations export task exceeded its attempt limit"
    );
  });

  it("多年增长导出固定为五类基础查询和三个留存查询", () => {
    const specs = buildOperationsExportQuerySpecs({
      ...task,
      exportType: "user_growth",
      query: {
        granularity: "day",
        range: {
          kind: "custom",
          from: "2020-01-01",
          to: "2026-02-01",
        },
      },
      highWatermarks: {
        users: null,
        webVisits: null,
        outputs: null,
        paymentOrders: null,
        paymentLifecycle: null,
        creditContributions: null,
      },
    });

    expect(specs).toHaveLength(8);
    expect(specs[0]).toEqual({
      kind: "cumulative_users",
      label: "cumulative_users",
    });
    expect(specs.filter((spec) => spec.kind === "cohort_export")).toEqual([
      {
        kind: "cohort_export",
        label: "retention_d1",
        retentionDay: 1,
      },
      {
        kind: "cohort_export",
        label: "retention_d7",
        retentionDay: 7,
      },
      {
        kind: "cohort_export",
        label: "retention_d30",
        retentionDay: 30,
      },
    ]);
  });

  it("完整用户增长导出通过真实 reader 解析所有查询类型", async () => {
    const dependencies = createDependencies();
    const userGrowthTask = {
      ...task,
      exportType: "user_growth" as const,
      query: {
        granularity: "day" as const,
        range: {
          kind: "custom" as const,
          from: "2026-01-01",
          to: "2026-01-31",
        },
      },
      highWatermarks: {
        users: null,
        webVisits: null,
        outputs: null,
        paymentOrders: null,
        paymentLifecycle: null,
        creditContributions: null,
      },
    };
    vi.mocked(dependencies.repository.claimNext).mockResolvedValue(
      userGrowthTask
    );
    dependencies.createRows = undefined;
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          user_id: "user-1",
          name: "User One",
          email: "user-1@example.com",
          role: "user",
          banned: false,
          business_time: "2026-01-15T00:00:00.000Z",
          retained: true,
        },
      ],
    });
    dependencies.detailRepository = createOperationsGrowthDetailRepository({
      transaction: async (work, config) => {
        expect(config).toEqual({
          isolationLevel: "repeatable read",
          accessMode: "read only",
        });
        return work({ execute });
      },
    });
    const uploadedChunks: Buffer[] = [];
    vi.mocked(dependencies.storage.putObjectStream).mockImplementation(
      async (_key, _bucket, data) => {
        for await (const chunk of data) uploadedChunks.push(Buffer.from(chunk));
      }
    );

    await processOperationsExportBatch(
      { limit: 1, workerId: "worker-1" },
      dependencies
    );

    expect(execute).toHaveBeenCalledTimes(8);
    const csv = Buffer.concat(uploadedChunks).toString("utf8");
    for (const label of [
      "cumulative_users",
      "users",
      "login_activity",
      "creation_activity",
      "payment_activity",
      "retention_d1",
      "retention_d7",
      "retention_d30",
    ]) {
      expect(csv).toContain(label);
    }
    expect(dependencies.repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({ rowCount: 8 })
    );
  });

  it("商业化导出同时保留创建订单、履约收入订单和生命周期事件", () => {
    expect(
      buildOperationsExportQuerySpecs({
        ...task,
        exportType: "commercialization",
        highWatermarks: {
          users: null,
          webVisits: null,
          outputs: null,
          paymentOrders: null,
          paymentLifecycle: null,
          creditContributions: null,
        },
      })
    ).toEqual([
      { kind: "orders", label: "orders" },
      { kind: "fulfilled_orders", label: "fulfilled_orders" },
      { kind: "payment_lifecycle", label: "payment_lifecycle" },
    ]);
  });

  it("数据库快照提交后才上传临时 CSV 对象", async () => {
    const dependencies = createDependencies();
    dependencies.createRows = undefined;
    vi.mocked(dependencies.repository.claimNext).mockResolvedValue({
      ...task,
      query: {
        granularity: "day",
        range: {
          kind: "custom",
          from: "2026-01-01",
          to: "2026-01-31",
        },
      },
      highWatermarks: {
        users: null,
        webVisits: null,
        outputs: null,
        paymentOrders: null,
        paymentLifecycle: null,
        creditContributions: null,
      },
    });
    let snapshotOpen = false;
    dependencies.detailRepository = {
      async withReadOnlySnapshot(work) {
        snapshotOpen = true;
        try {
          return await work({
            readHeader: vi.fn(),
            readRows: vi.fn().mockResolvedValue([
              {
                kind: "content",
                stableId: "image:task-1",
                taskId: "task-1",
                userId: "user-1",
                model: "model-1",
                mediaType: "image",
                businessTime: new Date("2026-02-01T00:00:00.000Z"),
                status: "completed",
                quantity: 1,
                videoSeconds: 0,
                netCredits: 1,
                operationCreatedAtMismatch: false,
              },
            ]),
          });
        } finally {
          snapshotOpen = false;
        }
      },
    };
    vi.mocked(dependencies.storage.putObjectStream).mockImplementation(
      async (_key, _bucket, data) => {
        expect(snapshotOpen).toBe(false);
        for await (const _chunk of data) {
          // 完整消费临时文件，验证上传发生在事务结束后。
        }
      }
    );

    await processOperationsExportBatch(
      { limit: 1, workerId: "worker-1" },
      dependencies
    );

    expect(loggerMocks.logError).not.toHaveBeenCalled();
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
    expect(dependencies.repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({ rowCount: 1 })
    );
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
      markOrphanCleanupFailed: vi.fn().mockResolvedValue(undefined),
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("记录孤儿删除失败水位以便持久轮转坏项", async () => {
    const dependencies = createCleanupDependencies();
    vi.mocked(dependencies.repository.listOrphans).mockResolvedValue([
      {
        auditId: "audit-failed",
        taskId: "task-failed",
        objectBucket: "exports",
        objectKey: "failed.csv",
      },
    ]);
    vi.mocked(dependencies.storage.deleteObject).mockRejectedValue(
      new Error("storage unavailable")
    );

    await expect(
      expireOperationsExportBatch({ limit: 1 }, dependencies)
    ).resolves.toEqual({ processed: 1 });
    expect(
      dependencies.repository.markOrphanCleanupFailed
    ).toHaveBeenCalledWith({
      auditId: "audit-failed",
      taskId: "task-failed",
      objectKey: "failed.csv",
      errorCode: "recorded_orphan_cleanup_failed",
      now: new Date("2026-02-08T00:00:01.000Z"),
    });
    expect(dependencies.repository.markOrphanDeleted).not.toHaveBeenCalled();
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
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        operation: "operations.expireExports",
        cleanupKind: "unreferenced_object",
        leaseStatus: "item_cleanup_failed",
        errorCode: "orphan_object_delete_failed",
        objectKey: "operations-exports/task-orphan/lease.csv",
      },
      "Operations export orphan object cleanup failed"
    );
    const firstCursor = vi.mocked(dependencies.storage.listObjects).mock
      .calls[0]?.[2]?.cursor;
    const secondCursor = vi.mocked(dependencies.storage.listObjects).mock
      .calls[1]?.[2]?.cursor;
    expect(secondCursor).toBe(firstCursor);
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

  it("multipart 单项终止失败会告警并从同一游标重试", async () => {
    const dependencies = createCleanupDependencies();
    const listMultipartUploads = dependencies.storage.listMultipartUploads;
    const abortMultipartUpload = dependencies.storage.abortMultipartUpload;
    if (!listMultipartUploads || !abortMultipartUpload) {
      throw new Error("multipart cleanup test capabilities missing");
    }
    vi.mocked(listMultipartUploads).mockResolvedValue({
      uploads: [
        {
          key: "operations-exports/task-stale/lease-stale.csv",
          initiatedAt: new Date("2026-02-01T00:00:00.000Z"),
          cleanupToken: "upload-stale",
        },
      ],
      nextCursor: "multipart-next-page",
    });
    vi.mocked(abortMultipartUpload)
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);

    await expireOperationsExportBatch({ limit: 10 }, dependencies);
    await expireOperationsExportBatch({ limit: 10 }, dependencies);

    expect(abortMultipartUpload).toHaveBeenCalledTimes(2);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        operation: "operations.expireExports",
        cleanupKind: "multipart_upload",
        leaseStatus: "item_cleanup_failed",
        errorCode: "multipart_abort_failed",
        objectKey: "operations-exports/task-stale/lease-stale.csv",
      },
      "Operations export multipart item cleanup failed"
    );
    const firstCursor =
      vi.mocked(listMultipartUploads).mock.calls[0]?.[2]?.cursor;
    const secondCursor =
      vi.mocked(listMultipartUploads).mock.calls[1]?.[2]?.cursor;
    expect(secondCursor).toBe(firstCursor);
  });
});
