/**
 * 运营总览顶层一致快照服务测试。
 *
 * 验证增长、商业化、内容与系统健康使用单个只读
 * repeatable-read 事务、单次 header 及同一生成时刻。
 */
import { type SQL, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { OperationsContentSnapshotHeader } from "./content-repository";
import {
  createOperationsDashboardService,
  type OperationsDashboardBuilders,
  type OperationsDashboardReaderFactories,
} from "./operations-dashboard-service";

/** 生成一个支持 execute 的最小事务替身。 */
function createDatabase() {
  const connection = {
    marker: "dashboard-transaction",
    execute: vi.fn(async function (this: { marker: string }, _query: SQL) {
      expect(this.marker).toBe("dashboard-transaction");
      return { rows: [] };
    }),
  };
  const transaction = vi.fn(async (work) => work(connection));
  return {
    execute: connection.execute,
    transaction,
    database: { transaction },
  };
}

/** 创建顶层测试不会真正调用的完整 reader 替身。 */
function createFactories(
  readHeader: () => Promise<OperationsContentSnapshotHeader>
): OperationsDashboardReaderFactories {
  return {
    growth: vi.fn(() => ({
      readHeader,
      readCumulativeUserCount: vi.fn(),
      readNewUserCount: vi.fn(),
      readActivityUserCount: vi.fn(),
      readNewUserSeries: vi.fn(),
      readActivitySeries: vi.fn(),
      readCohorts: vi.fn(),
    })),
    commercial: vi.fn(() => ({
      readHeader,
      readLifecycleCounts: vi.fn(),
      readRevenue: vi.fn(),
      readPayingUserCount: vi.fn(),
      readActivityUserCount: vi.fn(),
    })),
    content: vi.fn((execute) => ({
      async readHeader() {
        await execute(sql`select 1`);
        return readHeader();
      },
      readSeries: vi.fn(),
    })),
    health: vi.fn(() => ({
      readTaskHealth: vi.fn(),
      readFulfillmentFailures: vi.fn(),
      readQueueBacklog: vi.fn(),
      readBackendHealth: vi.fn(),
    })),
  };
}

/** 顶层服务复用所需的最小增长活跃指标夹具。 */
function createSharedActivityMetrics() {
  return {
    paymentActiveUsers: { current: 3, previous: 2 },
    creationActiveUsers: { current: 6, previous: 4 },
    loginActiveUsers: { current: 12, previous: 8 },
  };
}

describe("operations dashboard service", () => {
  it("所有模块共享一次 header 和唯一只读事务", async () => {
    const { database, transaction } = createDatabase();
    const sharedHeader = {
      asOf: new Date("2026-08-10T12:00:00.000Z"),
      epoch: {
        appDate: "2026-08-01",
        startsAt: new Date("2026-07-31T16:00:00.000Z"),
      },
      outputUsage: { version: 1, status: "ready" },
      creditUsage: { version: 1, status: "ready" },
    } as const;
    const readHeader = vi.fn().mockResolvedValue(sharedHeader);
    const factories = createFactories(readHeader);
    const range = {
      dataStart: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-08-11T00:00:00.000Z"),
      previous: {
        dataStart: new Date("2026-07-22T00:00:00.000Z"),
        end: new Date("2026-08-01T00:00:00.000Z"),
        availability: "available",
      },
      availability: "available",
    } as const;
    const growth = {
      generatedAt: "same",
      range,
      metrics: createSharedActivityMetrics(),
    };
    const builders = {
      growth: vi.fn().mockResolvedValue(growth),
      commercial: vi.fn().mockResolvedValue({ generatedAt: "same", range }),
      content: vi.fn().mockResolvedValue({ generatedAt: "same", range }),
      health: vi
        .fn()
        .mockResolvedValue({ queueBacklog: { status: "current" } }),
    } as unknown as OperationsDashboardBuilders;
    const service = createOperationsDashboardService({
      database,
      factories,
      builders,
    });

    const snapshot = await service.getOverview({}, "Asia/Shanghai");

    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(readHeader).toHaveBeenCalledOnce();
    expect(builders.growth).toHaveBeenCalledWith(
      {},
      "Asia/Shanghai",
      expect.anything(),
      sharedHeader
    );
    expect(builders.commercial).toHaveBeenCalledWith(
      {},
      "Asia/Shanghai",
      expect.anything(),
      sharedHeader,
      {
        current: { payment: 3, creation: 6, login: 12 },
        previous: { payment: 2, creation: 4, login: 8 },
      }
    );
    expect(builders.content).toHaveBeenCalledWith(
      {},
      "Asia/Shanghai",
      expect.anything(),
      sharedHeader
    );
    expect(snapshot.generatedAt).toBe(sharedHeader.asOf.toISOString());
    expect(snapshot.timeZone).toBe("Asia/Shanghai");
    expect(snapshot.epoch).toEqual(sharedHeader.epoch);
  });

  it("模块范围不一致时拒绝拼装为成功快照", async () => {
    const { database } = createDatabase();
    const readHeader = vi.fn().mockResolvedValue({
      asOf: new Date("2026-08-10T12:00:00.000Z"),
      epoch: {
        appDate: "2026-08-01",
        startsAt: new Date("2026-07-31T16:00:00.000Z"),
      },
      outputUsage: { version: 1, status: "ready" },
      creditUsage: { version: 1, status: "ready" },
    });
    const factories = createFactories(readHeader);
    const service = createOperationsDashboardService({
      database,
      factories,
      builders: {
        growth: vi.fn().mockResolvedValue({
          generatedAt: "same",
          range: { from: "2026-08-01", to: "2026-08-10" },
          metrics: createSharedActivityMetrics(),
        }),
        commercial: vi.fn().mockResolvedValue({
          generatedAt: "same",
          range: { from: "2026-08-02", to: "2026-08-10" },
        }),
        content: vi.fn().mockResolvedValue({
          generatedAt: "same",
          range: { from: "2026-08-01", to: "2026-08-10" },
        }),
        health: vi.fn().mockResolvedValue({}),
      } as unknown as OperationsDashboardBuilders,
    });

    await expect(
      service.getOverview({}, "Asia/Shanghai")
    ).rejects.toMatchObject({ code: "invalid_data" });
  });

  it("模块并发组装时同一事务 execute 始终串行", async () => {
    let activeQueries = 0;
    let maximumActiveQueries = 0;
    const connection = {
      async execute(_query: SQL) {
        activeQueries += 1;
        maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeQueries -= 1;
        return { rows: [] };
      },
    };
    const database = {
      transaction: vi.fn(async (work) => work(connection)),
    };
    const sharedHeader = {
      asOf: new Date("2026-08-10T12:00:00.000Z"),
      epoch: {
        appDate: "2026-08-01",
        startsAt: new Date("2026-07-31T16:00:00.000Z"),
      },
      outputUsage: { version: 1, status: "ready" },
      creditUsage: { version: 1, status: "ready" },
    } as const;
    const range = {
      dataStart: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-08-11T00:00:00.000Z"),
      previous: {
        dataStart: new Date("2026-07-22T00:00:00.000Z"),
        end: new Date("2026-08-01T00:00:00.000Z"),
        availability: "available",
      },
      availability: "available",
    } as const;
    const factories = {
      growth: (execute: (query: SQL) => Promise<unknown>) => ({
        readCumulativeUserCount: () => execute(sql`select 1`),
      }),
      commercial: (execute: (query: SQL) => Promise<unknown>) => ({
        readRevenue: () => execute(sql`select 2`),
      }),
      content: (execute: (query: SQL) => Promise<unknown>) => ({
        readHeader: async () => {
          await execute(sql`select 0`);
          return sharedHeader;
        },
        readSeries: () => execute(sql`select 3`),
      }),
      health: () => ({}),
    } as unknown as OperationsDashboardReaderFactories;
    const builders = {
      growth: async (
        _input: unknown,
        _timeZone: string,
        reader: ReturnType<OperationsDashboardReaderFactories["growth"]>
      ) => {
        await reader.readCumulativeUserCount(range.end);
        return {
          generatedAt: "same",
          range,
          metrics: createSharedActivityMetrics(),
        };
      },
      commercial: async (
        _input: unknown,
        _timeZone: string,
        reader: ReturnType<OperationsDashboardReaderFactories["commercial"]>
      ) => {
        await reader.readRevenue({ start: range.dataStart, end: range.end });
        return { generatedAt: "same", range };
      },
      content: async (
        _input: unknown,
        _timeZone: string,
        reader: ReturnType<OperationsDashboardReaderFactories["content"]>
      ) => {
        await reader.readSeries([]);
        return { generatedAt: "same", range };
      },
      health: vi.fn().mockResolvedValue({}),
    } as unknown as OperationsDashboardBuilders;

    await createOperationsDashboardService({
      database,
      factories,
      builders,
    }).getOverview({}, "Asia/Shanghai");

    expect(maximumActiveQueries).toBe(1);
  });
});
