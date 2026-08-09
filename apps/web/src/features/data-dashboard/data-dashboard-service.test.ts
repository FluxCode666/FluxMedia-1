/**
 * 用户数据看板聚合服务的 DB-free 测试。
 *
 * 使用方：Vitest；通过可注入只读快照仓储固定 readiness、查询顺序、成功产出、
 * 净积分、失败任务、模型排序与损坏读模型的整体失败语义。
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  buildDataDashboardCreditBucketsSql,
  buildDataDashboardFailedTasksSql,
  buildDataDashboardSnapshotHeaderSql,
  buildDataDashboardSuccessBucketsSql,
  createDataDashboardSnapshotRepository,
  DataDashboardServiceError,
  type DataDashboardSnapshotReader,
  type DataDashboardSnapshotRepository,
  type DataDashboardTransactionDatabase,
  loadDataDashboardSnapshot,
} from "./data-dashboard-service";

const AS_OF = new Date("2026-08-09T10:15:30.000Z");

/** 创建 ready 且带唯一数据库时钟的首条快照结果。 */
function createReadyHeader() {
  return {
    asOf: AS_OF,
    outputUsage: { version: 1, status: "ready" },
    creditUsage: { version: 1, status: "ready" },
  } as const;
}

/**
 * 创建可记录调用顺序的最小快照仓储。
 *
 * @param overrides 替换单个读取结果或 reader，实现异常与损坏数据场景。
 * @returns 仓储、reader spy 与实际调用序列；无数据库副作用。
 */
function createRepository(
  overrides: Partial<DataDashboardSnapshotReader> = {}
): {
  repository: DataDashboardSnapshotRepository;
  reader: DataDashboardSnapshotReader;
  calls: string[];
} {
  const calls: string[] = [];
  const reader: DataDashboardSnapshotReader = {
    readSnapshotHeader: vi.fn(async () => {
      calls.push("header");
      return createReadyHeader();
    }),
    readSuccessBuckets: vi.fn(async () => {
      calls.push("success");
      return [
        {
          date: "2026-08-03",
          imageCount: 4,
          imageTaskCount: 1,
          videoCount: 1,
          videoSeconds: 5,
        },
      ];
    }),
    readCreditBuckets: vi.fn(async () => {
      calls.push("credits");
      return [
        {
          date: "2026-08-03",
          creditsConsumed: 60,
          operationCreatedAtMismatchCount: 0,
        },
      ];
    }),
    readModelUsage: vi.fn(async () => {
      calls.push("models");
      return [
        { model: "video-model", taskCount: 1 },
        { model: "image-model", taskCount: 1 },
      ];
    }),
    readFailedTasks: vi.fn(async () => {
      calls.push("failed");
      return {
        imageFailedCount: 1,
        videoFailedCount: 0,
        successOverlapCount: 0,
      };
    }),
    ...overrides,
  };
  const repository: DataDashboardSnapshotRepository = {
    async withReadOnlySnapshot<T>(work: (value: DataDashboardSnapshotReader) => Promise<T>) {
      calls.push("transaction:start");
      try {
        return await work(reader);
      } finally {
        calls.push("transaction:end");
      }
    },
  };
  return { repository, reader, calls };
}

describe("loadDataDashboardSnapshot", () => {
  it("在一个串行快照中派生多图片、视频、净积分与成功率", async () => {
    const { repository, reader, calls } = createRepository();

    const result = await loadDataDashboardSnapshot(
      { userId: "user-a", timeZone: "Asia/Shanghai", rangeInput: {} },
      repository
    );

    expect(calls).toEqual([
      "transaction:start",
      "header",
      "success",
      "credits",
      "models",
      "failed",
      "transaction:end",
    ]);
    expect(result).toMatchObject({
      asOf: AS_OF.toISOString(),
      timeZone: "Asia/Shanghai",
      today: "2026-08-09",
      range: { startDate: "2026-08-03", endDate: "2026-08-09" },
      metrics: {
        imageCount: 4,
        videoSeconds: 5,
        creditsConsumed: 60,
        successRate: {
          succeeded: 2,
          failed: 1,
          terminal: 3,
          rate: 2 / 3,
        },
        activeDays: 1,
        mostUsedModel: { model: "image-model", taskCount: 1 },
      },
      taskComposition: {
        imageTaskCount: 1,
        videoCount: 1,
        totalTasks: 2,
      },
    });
    expect(result.buckets).toHaveLength(7);
    expect(result.buckets[0]).toMatchObject({
      date: "2026-08-03",
      imageCount: 4,
      imageTaskCount: 1,
      videoCount: 1,
      videoSeconds: 5,
      creditsConsumed: 60,
    });
    expect(result.buckets.slice(1).every((bucket) => bucket.imageCount === 0)).toBe(
      true
    );
    const expectedQuery = {
      userId: "user-a",
      start: new Date("2026-08-02T16:00:00.000Z"),
      end: AS_OF,
      timeZone: "Asia/Shanghai",
    };
    expect(reader.readSuccessBuckets).toHaveBeenCalledWith(expectedQuery);
    expect(reader.readCreditBuckets).toHaveBeenCalledWith(expectedQuery);
    expect(reader.readModelUsage).toHaveBeenCalledWith(expectedQuery);
    expect(reader.readFailedTasks).toHaveBeenCalledWith(expectedQuery);
  });

  it("在 readiness 缺失时停止于首条读取且返回稳定 not_ready", async () => {
    const { repository, reader, calls } = createRepository({
      readSnapshotHeader: vi.fn(async () => {
        calls.push("header");
        return {
          asOf: AS_OF,
          outputUsage: null,
          creditUsage: { version: 1, status: "ready" },
        };
      }),
    });

    await expect(
      loadDataDashboardSnapshot(
        { userId: "user-a", timeZone: "Asia/Shanghai", rangeInput: {} },
        repository
      )
    ).rejects.toMatchObject({
      name: "DataDashboardServiceError",
      code: "not_ready",
    });
    expect(reader.readSuccessBuckets).not.toHaveBeenCalled();
    expect(calls).toEqual(["transaction:start", "header", "transaction:end"]);
  });

  it("无成功任务时补齐连续零桶并返回可空成功率", async () => {
    const { repository } = createRepository({
      readSuccessBuckets: vi.fn(async () => []),
      readCreditBuckets: vi.fn(async () => []),
      readModelUsage: vi.fn(async () => []),
      readFailedTasks: vi.fn(async () => ({
        imageFailedCount: 0,
        videoFailedCount: 0,
        successOverlapCount: 0,
      })),
    });

    const result = await loadDataDashboardSnapshot(
      {
        userId: "user-empty",
        timeZone: "Asia/Shanghai",
        rangeInput: { startDate: "2026-08-01", endDate: "2026-08-02" },
      },
      repository
    );

    expect(result.buckets).toHaveLength(2);
    expect(result.metrics).toEqual({
      imageCount: 0,
      videoSeconds: 0,
      creditsConsumed: 0,
      successRate: { succeeded: 0, failed: 0, terminal: 0, rate: null },
      activeDays: 0,
      mostUsedModel: null,
    });
  });

  it("只有失败媒体任务时返回 0% 且不制造成功产出", async () => {
    const { repository } = createRepository({
      readSuccessBuckets: vi.fn(async () => []),
      readCreditBuckets: vi.fn(async () => []),
      readModelUsage: vi.fn(async () => []),
      readFailedTasks: vi.fn(async () => ({
        imageFailedCount: 2,
        videoFailedCount: 1,
        successOverlapCount: 0,
      })),
    });

    const result = await loadDataDashboardSnapshot(
      { userId: "user-failed", timeZone: "Asia/Shanghai", rangeInput: {} },
      repository
    );

    expect(result.metrics.successRate).toEqual({
      succeeded: 0,
      failed: 3,
      terminal: 3,
      rate: 0,
    });
    expect(result.taskComposition.totalTasks).toBe(0);
  });

  it("按任务数降序和模型 ID 升序稳定选择常用模型", async () => {
    const { repository } = createRepository({
      readModelUsage: vi.fn(async () => [
        { model: "z-model", taskCount: 1 },
        { model: "a-model", taskCount: 1 },
      ]),
    });

    const result = await loadDataDashboardSnapshot(
      { userId: "user-a", timeZone: "Asia/Shanghai", rangeInput: {} },
      repository
    );

    expect(result.metrics.mostUsedModel).toEqual({
      model: "a-model",
      taskCount: 1,
    });
  });

  it("拒绝积分 operation 时间漂移和成功/失败状态重叠", async () => {
    const mismatch = createRepository({
      readCreditBuckets: vi.fn(async () => [
        {
          date: "2026-08-03",
          creditsConsumed: 60,
          operationCreatedAtMismatchCount: 1,
        },
      ]),
    });
    const overlap = createRepository({
      readFailedTasks: vi.fn(async () => ({
        imageFailedCount: 1,
        videoFailedCount: 0,
        successOverlapCount: 1,
      })),
    });

    await expect(
      loadDataDashboardSnapshot(
        { userId: "user-a", timeZone: "Asia/Shanghai", rangeInput: {} },
        mismatch.repository
      )
    ).rejects.toBeInstanceOf(DataDashboardServiceError);
    await expect(
      loadDataDashboardSnapshot(
        { userId: "user-a", timeZone: "Asia/Shanghai", rangeInput: {} },
        overlap.repository
      )
    ).rejects.toMatchObject({ code: "invalid_data" });
  });

  it("拒绝负数、重复日期、范围外桶与模型任务总数漂移", async () => {
    const negative = createRepository({
      readSuccessBuckets: vi.fn(async () => [
        {
          date: "2026-08-03",
          imageCount: -1,
          imageTaskCount: 1,
          videoCount: 1,
          videoSeconds: 5,
        },
      ]),
    });
    const duplicate = createRepository({
      readSuccessBuckets: vi.fn(async () => [
        {
          date: "2026-08-03",
          imageCount: 2,
          imageTaskCount: 1,
          videoCount: 0,
          videoSeconds: 0,
        },
        {
          date: "2026-08-03",
          imageCount: 2,
          imageTaskCount: 0,
          videoCount: 1,
          videoSeconds: 5,
        },
      ]),
    });
    const outside = createRepository({
      readCreditBuckets: vi.fn(async () => [
        {
          date: "2026-07-31",
          creditsConsumed: 1,
          operationCreatedAtMismatchCount: 0,
        },
      ]),
    });
    const modelDrift = createRepository({
      readModelUsage: vi.fn(async () => [
        { model: "only-one", taskCount: 1 },
      ]),
    });
    const missingCreditBucket = createRepository({
      readCreditBuckets: vi.fn(async () => []),
    });

    for (const repository of [
      negative.repository,
      duplicate.repository,
      outside.repository,
      modelDrift.repository,
      missingCreditBucket.repository,
    ]) {
      await expect(
        loadDataDashboardSnapshot(
          { userId: "user-a", timeZone: "Asia/Shanghai", rangeInput: {} },
          repository
        )
      ).rejects.toMatchObject({ code: "invalid_data" });
    }
  });

  it("将非法范围稳定分类为 validation_error 且不读取聚合", async () => {
    const { repository, reader } = createRepository();

    await expect(
      loadDataDashboardSnapshot(
        {
          userId: "user-a",
          timeZone: "Asia/Shanghai",
          rangeInput: { startDate: "2026-07-10", endDate: "2026-08-09" },
        },
        repository
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(reader.readSuccessBuckets).not.toHaveBeenCalled();
  });
});

describe("data dashboard production SQL", () => {
  it("生产仓储固定使用只读 repeatable-read 事务配置", async () => {
    const transaction = vi.fn();
    const database: DataDashboardTransactionDatabase = {
      async transaction<T>(
        work: (transaction: {
          execute: (query: SQL) => Promise<unknown>;
        }) => Promise<T>,
        config: {
          isolationLevel: "repeatable read";
          accessMode: "read only";
        }
      ): Promise<T> {
        transaction(work, config);
        return "snapshot-result" as T;
      },
    };
    const repository = createDataDashboardSnapshotRepository(database);

    await expect(
      repository.withReadOnlySnapshot(async () => "unused")
    ).resolves.toBe("snapshot-result");
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });

  it("将 readiness 与 transaction_timestamp 固定在首条 SQL", () => {
    const query = new PgDialect().sqlToQuery(
      buildDataDashboardSnapshotHeaderSql()
    );

    expect(query.sql).toContain("transaction_timestamp()");
    expect(query.sql).toContain("output_usage");
    expect(query.sql).toContain("credit_usage");
  });

  it("所有业务查询都限定本人半开范围且积分只由成功事件驱动", () => {
    const input = {
      userId: "user-a",
      start: new Date("2026-08-02T16:00:00.000Z"),
      end: AS_OF,
      timeZone: "Asia/Shanghai",
    };
    const dialect = new PgDialect();
    const success = dialect.sqlToQuery(buildDataDashboardSuccessBucketsSql(input));
    const credits = dialect.sqlToQuery(buildDataDashboardCreditBucketsSql(input));
    const failed = dialect.sqlToQuery(buildDataDashboardFailedTasksSql(input));

    for (const query of [success, credits, failed]) {
      expect(query.params).toContain("user-a");
      expect(query.params).toContain(input.start.toISOString());
      expect(query.params).toContain(input.end.toISOString());
    }
    expect(credits.sql).toContain('from "user_output_usage_event"');
    expect(credits.sql).toContain('left join "credit_usage_operation"');
    expect(credits.sql).not.toContain("credits_transaction");
    expect(failed.sql).toContain("generate");
    expect(failed.sql).toContain("edit");
  });
});
