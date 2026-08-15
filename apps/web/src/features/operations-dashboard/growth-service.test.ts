/**
 * 运营总览用户增长快照服务测试。
 *
 * 使用内存 reader 覆盖 epoch 门禁、存量账户基数、API Key-only 创作、逐桶去重、
 * 跨筛选结束日的精确 Cohort 留存以及上线前状态。
 */
import { describe, expect, it, vi } from "vitest";

import type {
  OperationsGrowthCohortRow,
  OperationsGrowthRepository,
  OperationsGrowthSnapshotReader,
} from "./growth-repository";
import {
  loadOperationsGrowthSnapshot,
  type OperationsGrowthServiceError,
} from "./growth-service";

type ReaderOverrides = Partial<OperationsGrowthSnapshotReader>;

/** 构造有固定时钟和 epoch 的内存 reader，单个测试只覆盖关心的读取。 */
function createReader(
  overrides: ReaderOverrides = {}
): OperationsGrowthSnapshotReader {
  return {
    readHeader: vi.fn().mockResolvedValue({
      asOf: new Date("2026-08-10T12:00:00.000Z"),
      epoch: {
        appDate: "2026-08-01",
        startsAt: new Date("2026-07-31T16:00:00.000Z"),
      },
    }),
    readCumulativeUserCount: vi.fn().mockResolvedValue(100),
    readNewUserCount: vi.fn().mockResolvedValue(0),
    readActivityUserCount: vi.fn().mockResolvedValue(0),
    readNewUserSeries: vi.fn().mockResolvedValue([]),
    readActivitySeries: vi.fn().mockResolvedValue([]),
    readCohorts: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** 把 reader 固定到一次快照仓储调用。 */
function createRepository(
  reader: OperationsGrowthSnapshotReader
): OperationsGrowthRepository {
  return {
    withReadOnlySnapshot: (work) => work(reader),
  };
}

describe("operations growth service", () => {
  it("epoch 未初始化时在任何业务查询前明确失败", async () => {
    const reader = createReader({
      readHeader: vi.fn().mockResolvedValue({
        asOf: new Date("2026-08-10T12:00:00.000Z"),
        epoch: null,
      }),
    });

    await expect(
      loadOperationsGrowthSnapshot(
        {},
        "Asia/Shanghai",
        createRepository(reader)
      )
    ).rejects.toMatchObject({
      code: "not_ready",
    } satisfies Partial<OperationsGrowthServiceError>);
    expect(reader.readCumulativeUserCount).not.toHaveBeenCalled();
  });

  it("累计用户保留上线前基数，新增与活跃按当期和上期分别读取", async () => {
    const readCumulativeUserCount = vi
      .fn()
      .mockResolvedValueOnce(105)
      .mockResolvedValueOnce(100);
    const readNewUserCount = vi
      .fn()
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2);
    const readActivityUserCount = vi.fn(
      async (kind: "login" | "creation" | "payment") =>
        ({ login: 3, creation: 4, payment: 1 })[kind]
    );
    const reader = createReader({
      readCumulativeUserCount,
      readNewUserCount,
      readActivityUserCount,
    });

    const snapshot = await loadOperationsGrowthSnapshot(
      {
        range: { kind: "custom", from: "2026-08-08", to: "2026-08-10" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.metrics.cumulativeUsers.current).toBe(105);
    expect(snapshot.metrics.cumulativeUsers.previous).toBe(100);
    expect(snapshot.metrics.newUsers.current).toBe(5);
    expect(snapshot.metrics.newUsers.previous).toBe(2);
    expect(readCumulativeUserCount).toHaveBeenCalledTimes(2);
    expect(readActivityUserCount).toHaveBeenCalledTimes(6);
  });

  it("API Key-only 成功创作只增加创作活跃，不会隐式增加登录活跃", async () => {
    const readActivityUserCount = vi.fn(
      async (kind: "login" | "creation" | "payment") =>
        kind === "creation" ? 1 : 0
    );
    const reader = createReader({ readActivityUserCount });

    const snapshot = await loadOperationsGrowthSnapshot(
      {
        range: { kind: "custom", from: "2026-08-08", to: "2026-08-10" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.metrics.creationActiveUsers.current).toBe(1);
    expect(snapshot.metrics.loginActiveUsers.current).toBe(0);
  });

  it("稀疏趋势填充真实零值，同时保留 epoch 前桶状态", async () => {
    const reader = createReader({
      readNewUserSeries: vi
        .fn()
        .mockResolvedValue([{ bucketKey: "day:2026-08-02", userCount: 2 }]),
    });

    const snapshot = await loadOperationsGrowthSnapshot(
      {
        range: { kind: "custom", from: "2026-07-31", to: "2026-08-02" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.series.newUsers.map((bucket) => bucket.status)).toEqual([
      "pre_epoch",
      "value",
      "value",
    ]);
    expect(snapshot.series.newUsers[1]).toMatchObject({ value: 0 });
    expect(snapshot.series.newUsers[2]).toMatchObject({ value: 2 });
  });

  it("范围完全位于 epoch 前时指标标记为上线前而非真实零值", async () => {
    const reader = createReader();

    const snapshot = await loadOperationsGrowthSnapshot(
      {
        range: { kind: "custom", from: "2026-07-28", to: "2026-07-30" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.metrics.newUsers).toMatchObject({
      status: "pre_epoch",
      current: 0,
    });
    expect(snapshot.metrics.loginActiveUsers.status).toBe("pre_epoch");
    expect(snapshot.metrics.cumulativeUsers.status).toBe("value");
    expect(reader.readNewUserCount).not.toHaveBeenCalled();
  });

  it("D1 精确留存计入范围结束后行为，D7 真实为零，D30 保持未成熟", async () => {
    const cohorts: OperationsGrowthCohortRow[] = [
      {
        cohortDate: "2026-08-02",
        cohortSize: 2,
        retainedD1: 1,
        retainedD7: 0,
        retainedD30: 0,
      },
    ];
    const readCohorts = vi
      .fn()
      .mockResolvedValueOnce(cohorts)
      .mockResolvedValueOnce([]);
    const reader = createReader({ readCohorts });

    const snapshot = await loadOperationsGrowthSnapshot(
      {
        range: { kind: "custom", from: "2026-08-02", to: "2026-08-02" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.cohorts[0]?.d1).toMatchObject({
      status: "value",
      retainedCount: 1,
      rate: 0.5,
    });
    expect(snapshot.cohorts[0]?.d7).toMatchObject({
      status: "value",
      retainedCount: 0,
      rate: 0,
    });
    expect(snapshot.cohorts[0]?.d30.status).toBe("immature");
    const firstCohortQuery = readCohorts.mock.calls[0]?.[0];
    expect(firstCohortQuery.end).toEqual(new Date("2026-08-02T16:00:00.000Z"));
    expect(firstCohortQuery.asOf).toEqual(new Date("2026-08-10T12:00:00.000Z"));
  });

  it("无成熟 Cohort 时顶部留存不伪造为零", async () => {
    const reader = createReader({
      readCohorts: vi
        .fn()
        .mockResolvedValueOnce([
          {
            cohortDate: "2026-08-10",
            cohortSize: 1,
            retainedD1: 0,
            retainedD7: 0,
            retainedD30: 0,
          },
        ])
        .mockResolvedValueOnce([]),
    });

    const snapshot = await loadOperationsGrowthSnapshot(
      {
        range: { kind: "custom", from: "2026-08-10", to: "2026-08-10" },
        granularity: "day",
      },
      "Asia/Shanghai",
      createRepository(reader)
    );

    expect(snapshot.metrics.d1Retention.current.status).toBe("immature");
    expect(snapshot.metrics.d1Retention.comparison).toEqual({
      status: "not_comparable",
      reason: "retention_unavailable",
    });
  });

  it("拒绝内存仓储返回的非法计数", async () => {
    const reader = createReader({
      readCumulativeUserCount: vi.fn().mockResolvedValue(-1),
    });

    await expect(
      loadOperationsGrowthSnapshot(
        {},
        "Asia/Shanghai",
        createRepository(reader)
      )
    ).rejects.toMatchObject({ code: "invalid_data" });
  });

  it("拒绝 Cohort 仓储返回查询范围外的注册日", async () => {
    const reader = createReader({
      readCohorts: vi.fn().mockResolvedValue([
        {
          cohortDate: "2026-08-09",
          cohortSize: 1,
          retainedD1: 0,
          retainedD7: 0,
          retainedD30: 0,
        },
      ]),
    });

    await expect(
      loadOperationsGrowthSnapshot(
        {
          range: { kind: "custom", from: "2026-08-08", to: "2026-08-08" },
          granularity: "day",
        },
        "Asia/Shanghai",
        createRepository(reader)
      )
    ).rejects.toMatchObject({ code: "invalid_data" });
  });
});
