/**
 * 运营总览顶层一致快照服务。
 *
 * 使用方：后续 operations UOL binding。本服务只开启一次只读
 * repeatable-read 事务，并将同一 execute 与 header 传给增长、商业化、
 * 内容和系统健康模块，避免跨快照拼装。
 */
import type { SQL } from "drizzle-orm";

import {
  createOperationsCommercialSnapshotReader,
  type OperationsCommercialSnapshotReader,
} from "./commercial-repository";
import {
  buildOperationsCommercialSnapshot,
  type OperationsCommercialSnapshot,
} from "./commercial-service";
import {
  createOperationsContentSnapshotReader,
  type OperationsContentSnapshotReader,
} from "./content-repository";
import {
  buildOperationsContentSnapshot,
  type OperationsContentSnapshot,
} from "./content-service";
import {
  createOperationsGrowthSnapshotReader,
  type OperationsGrowthSnapshotReader,
} from "./growth-repository";
import {
  buildOperationsGrowthSnapshot,
  type OperationsGrowthSnapshot,
} from "./growth-service";
import {
  buildOperationsSystemHealthSnapshot,
  createOperationsHealthSnapshotReader,
  type OperationsHealthSnapshotReader,
  type OperationsSystemHealthSnapshot,
} from "./health-adapter";

type ExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与集成测试共用的最小事务数据库端口。 */
export interface OperationsDashboardTransactionDatabase {
  transaction<T>(
    work: (transaction: { execute: ExecuteSql }) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ): Promise<T>;
}

/** 从同一 execute 构造四个模块 reader 的工厂集。 */
export type OperationsDashboardReaderFactories = {
  growth: (execute: ExecuteSql) => OperationsGrowthSnapshotReader;
  commercial: (execute: ExecuteSql) => OperationsCommercialSnapshotReader;
  content: (execute: ExecuteSql) => OperationsContentSnapshotReader;
  health: (execute: ExecuteSql) => OperationsHealthSnapshotReader;
};

/** 顶层服务可注入的四个模块 builder。 */
export type OperationsDashboardBuilders = {
  growth: typeof buildOperationsGrowthSnapshot;
  commercial: typeof buildOperationsCommercialSnapshot;
  content: typeof buildOperationsContentSnapshot;
  health: typeof buildOperationsSystemHealthSnapshot;
};

/** 运营总览服务的稳定错误。 */
export class OperationsDashboardServiceError extends Error {
  /** 创建不泄露 SQL 或模块内部行的错误。 */
  constructor(
    readonly code: "not_ready" | "invalid_data",
    message: string
  ) {
    super(message);
    this.name = "OperationsDashboardServiceError";
  }
}

/** 运营总览所有模块的单一快照响应。 */
export type OperationsDashboardOverview = {
  generatedAt: string;
  timeZone: string;
  epoch: { appDate: string; startsAt: Date };
  schemaVersion: 1;
  range: OperationsGrowthSnapshot["range"];
  growth: OperationsGrowthSnapshot;
  commercial: OperationsCommercialSnapshot;
  content: OperationsContentSnapshot;
  systemHealth: OperationsSystemHealthSnapshot;
};

/** 顶层服务对 UOL binding 暴露的读端口。 */
export interface OperationsDashboardService {
  getOverview(
    input: unknown,
    timeZone: string
  ): Promise<OperationsDashboardOverview>;
}

const defaultFactories: OperationsDashboardReaderFactories = {
  growth: createOperationsGrowthSnapshotReader,
  commercial: createOperationsCommercialSnapshotReader,
  content: createOperationsContentSnapshotReader,
  health: createOperationsHealthSnapshotReader,
};

const defaultBuilders: OperationsDashboardBuilders = {
  growth: buildOperationsGrowthSnapshot,
  commercial: buildOperationsCommercialSnapshot,
  content: buildOperationsContentSnapshot,
  health: buildOperationsSystemHealthSnapshot,
};

/** 为比较构造可稳定序列化的范围指纹。 */
function rangeFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * 创建可注入依赖的运营总览服务。
 *
 * @param dependencies 数据库、reader 工厂和模块 builder。
 * @returns 仅包含一致快照读取的服务。
 * @sideEffects 每次读取仅开启一个只读 repeatable-read 事务。
 */
export function createOperationsDashboardService(dependencies: {
  database: OperationsDashboardTransactionDatabase;
  factories?: OperationsDashboardReaderFactories;
  builders?: OperationsDashboardBuilders;
}): OperationsDashboardService {
  const factories = dependencies.factories ?? defaultFactories;
  const builders = dependencies.builders ?? defaultBuilders;
  return {
    async getOverview(input, timeZone) {
      return dependencies.database.transaction(
        async (transaction) => {
          // Drizzle execute 依赖事务实例上的 dialect；裸传方法会在真实 PostgreSQL
          // 丢失 this，所有 reader 必须共享同一个显式绑定的执行函数。
          const execute = transaction.execute.bind(transaction);
          const growthReader = factories.growth(execute);
          const commercialReader = factories.commercial(execute);
          const contentReader = factories.content(execute);
          const healthReader = factories.health(execute);
          const sharedHeader = await contentReader.readHeader();
          if (!sharedHeader.epoch) {
            throw new OperationsDashboardServiceError(
              "not_ready",
              "运营统计起点尚未初始化"
            );
          }
          const [growth, commercial, content] = await Promise.all([
            builders.growth(input, timeZone, growthReader, sharedHeader),
            builders.commercial(
              input,
              timeZone,
              commercialReader,
              sharedHeader
            ),
            builders.content(input, timeZone, contentReader, sharedHeader),
          ]);
          const expectedRange = rangeFingerprint(growth.range);
          if (
            rangeFingerprint(commercial.range) !== expectedRange ||
            rangeFingerprint(content.range) !== expectedRange
          ) {
            throw new OperationsDashboardServiceError(
              "invalid_data",
              "运营总览模块范围不一致"
            );
          }
          const toQueryRange = (value: {
            dataStart: Date | null;
            end: Date;
          }) => ({ start: value.dataStart ?? value.end, end: value.end });
          const systemHealth = await builders.health({
            reader: healthReader,
            currentRange: toQueryRange(growth.range),
            previousRange: toQueryRange(growth.range.previous),
            currentAvailable: growth.range.dataStart !== null,
            previousAvailability: growth.range.previous.availability,
          });
          return {
            generatedAt: sharedHeader.asOf.toISOString(),
            timeZone,
            epoch: sharedHeader.epoch,
            schemaVersion: 1 as const,
            range: growth.range,
            growth,
            commercial,
            content,
            systemHealth,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
  };
}

/** 生产顶层服务延迟导入数据库，保持 DB-free Vitest 可注入替身。 */
export const databaseOperationsDashboardService: OperationsDashboardService = {
  async getOverview(input, timeZone) {
    const { db } = await import("@repo/database");
    return createOperationsDashboardService({
      database: db as unknown as OperationsDashboardTransactionDatabase,
    }).getOverview(input, timeZone);
  },
};
