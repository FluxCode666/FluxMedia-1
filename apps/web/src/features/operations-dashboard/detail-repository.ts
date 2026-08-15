/**
 * 运营总览明细仓储的稳定公共入口、分页器与只读快照执行适配器。
 *
 * 使用方：运营明细服务、CSV worker、测试与 reconciliation fixture。各领域 SQL
 * 构造器下沉到专用模块，但本文件继续导出原有路径，避免调用方感知内部拆分。
 */
import type { SQL } from "drizzle-orm";

import { buildOperationsCommercialDetailSql } from "./detail-commercial-sql";
import { buildOperationsContentDetailSql } from "./detail-content-sql";
import type {
  OperationsDetailCursor,
  OperationsDetailExecuteSql,
  OperationsDetailQuery,
  OperationsDetailRow,
  OperationsGrowthDetailPage,
  OperationsGrowthDetailRepository,
  OperationsGrowthDetailRow,
  OperationsGrowthDetailSnapshotReader,
  OperationsGrowthDetailTransactionDatabase,
} from "./detail-contracts";
import { buildOperationsGrowthDetailSql } from "./detail-growth-sql";
import {
  parseOperationsCommercialDetailRows,
  parseOperationsContentDetailRows,
  parseOperationsGrowthDetailRows,
} from "./detail-row-parsers";
import { createOperationsGrowthSnapshotReader } from "./growth-repository";

export { buildOperationsCommercialDetailSql } from "./detail-commercial-sql";
export { buildOperationsContentDetailSql } from "./detail-content-sql";
export type {
  OperationsActivityDetailQuery,
  OperationsCohortDetailQuery,
  OperationsCohortExportDetailQuery,
  OperationsCommercialDetailQuery,
  OperationsCommercialDetailRow,
  OperationsContentDetailQuery,
  OperationsContentDetailRow,
  OperationsCumulativeUserDetailQuery,
  OperationsDetailCursor,
  OperationsDetailHighWatermarks,
  OperationsDetailQuery,
  OperationsDetailRepository,
  OperationsDetailRow,
  OperationsFulfilledOrderDetailQuery,
  OperationsGrowthDetailCursor,
  OperationsGrowthDetailPage,
  OperationsGrowthDetailQuery,
  OperationsGrowthDetailRepository,
  OperationsGrowthDetailRow,
  OperationsGrowthDetailSnapshotReader,
  OperationsGrowthDetailTransactionDatabase,
  OperationsNewUserDetailQuery,
  OperationsOrderDetailQuery,
  OperationsPaymentLifecycleDetailQuery,
  OperationsPaymentStageDetailQuery,
} from "./detail-contracts";
export {
  buildOperationsActivityDetailSql,
  buildOperationsCohortDetailSql,
  buildOperationsCohortExportDetailSql,
  buildOperationsCumulativeUserDetailSql,
  buildOperationsGrowthDetailSql,
  buildOperationsNewUserDetailSql,
} from "./detail-growth-sql";

type OperationsDetailExecution = {
  query: SQL;
  parseResult(result: unknown): OperationsDetailRow[];
};

/**
 * 在一次穷尽分派中绑定查询与对应结果 parser。
 *
 * WHY：新增 query kind 时，SQL 与 parser 必须同时更新；never 分支让漏同步在
 * TypeScript 编译阶段失败，而不是在真实导出中才触发 Zod 错误。
 *
 * @param input 已通过服务层构造的封闭运营明细查询。
 * @returns 对应领域的 SQL 与数据库结果解析器，不执行查询。
 */
function createOperationsDetailExecution(
  input: OperationsDetailQuery
): OperationsDetailExecution {
  switch (input.kind) {
    case "cumulative_users":
    case "users":
    case "activity":
    case "cohort":
    case "cohort_export":
      return {
        query: buildOperationsGrowthDetailSql(input),
        parseResult: parseOperationsGrowthDetailRows,
      };
    case "orders":
    case "fulfilled_orders":
    case "payment_lifecycle":
    case "payment_stage":
      return {
        query: buildOperationsCommercialDetailSql(input),
        parseResult: parseOperationsCommercialDetailRows,
      };
    case "content":
      return {
        query: buildOperationsContentDetailSql(input),
        parseResult: parseOperationsContentDetailRows,
      };
    default: {
      const exhaustiveInput: never = input;
      return exhaustiveInput;
    }
  }
}

/**
 * 根据模块选择与汇总同源的运营明细 SQL。
 *
 * @param input 任意封闭运营明细查询。
 * @returns 对应领域的参数化 SQL，不执行数据库访问。
 * @throws RangeError 领域构造器校验到非法边界或游标时抛出。
 */
export function buildOperationsDetailSql(input: OperationsDetailQuery): SQL {
  return createOperationsDetailExecution(input).query;
}

/**
 * 将 limit+1 增长仓储行切分为当页与下一页 keyset。
 *
 * @param rows 仓储按 business_time、user_id 降序返回的原始行。
 * @param pageSize 对外页大小，仓储查询 limit 应等于 pageSize + 1。
 * @returns 最多 pageSize 行；仅存在额外行时签发原始结构游标。
 * @throws RangeError 页大小或仓储返回行数违反分页契约时抛出。
 */
export function paginateOperationsGrowthDetailRows(
  rows: readonly OperationsGrowthDetailRow[],
  pageSize: number
): OperationsGrowthDetailPage {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 10_000 ||
    rows.length > pageSize + 1
  ) {
    throw new RangeError("运营增长明细分页无效");
  }
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows.at(-1);
  return {
    rows: pageRows,
    nextCursor:
      rows.length > pageSize && lastRow
        ? {
            businessTime: lastRow.businessTime,
            businessTimeKey: lastRow.businessTimeKey,
            stableId: lastRow.userId,
          }
        : null,
  };
}

/**
 * 将任意模块的 limit+1 行切分为稳定 keyset 页。
 *
 * @param rows 按领域稳定降序返回的增长、商业化或内容明细行。
 * @param pageSize 对外页大小，仓储查询 limit 应等于 pageSize + 1。
 * @returns 当页明细行与仅在存在下一页时签发的原始结构游标。
 * @throws RangeError 页大小或仓储返回行数违反分页契约时抛出。
 */
export function paginateOperationsDetailRows(
  rows: readonly OperationsDetailRow[],
  pageSize: number
): { rows: OperationsDetailRow[]; nextCursor: OperationsDetailCursor | null } {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 10_000 ||
    rows.length > pageSize + 1
  ) {
    throw new RangeError("运营明细分页无效");
  }
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows.at(-1);
  return {
    rows: pageRows,
    nextCursor:
      rows.length > pageSize && lastRow
        ? {
            businessTime: lastRow.businessTime,
            businessTimeKey: lastRow.businessTimeKey,
            stableId: "stableId" in lastRow ? lastRow.stableId : lastRow.userId,
          }
        : null,
  };
}

/**
 * 将唯一事务 execute 绑定为明细与快照头的组合 reader。
 *
 * @param execute 当前只读事务绑定的 Drizzle execute 端口。
 * @returns 在同一事务快照中读取头部与领域明细行的 reader。
 * @throws ZodError 数据库返回行不满足领域 parser 契约时抛出。
 */
function createOperationsGrowthDetailSnapshotReader(
  execute: OperationsDetailExecuteSql
): OperationsGrowthDetailSnapshotReader {
  const growthReader = createOperationsGrowthSnapshotReader(execute);
  return {
    readHeader: growthReader.readHeader,
    async readRows(input) {
      const execution = createOperationsDetailExecution(input);
      return execution.parseResult(await execute(execution.query));
    },
  };
}

/**
 * 从 Drizzle 类数据库端口创建单一 repeatable-read 明细仓储。
 *
 * @param database 支持事务的数据库适配端口。
 * @returns 每次工作单元只开启一个只读 repeatable-read 事务的仓储。
 * @throws Error 数据库开启事务、执行查询或提交失败时原样上抛。
 */
export function createOperationsGrowthDetailRepository(
  database: OperationsGrowthDetailTransactionDatabase
): OperationsGrowthDetailRepository {
  return {
    withReadOnlySnapshot<T>(
      work: (reader: OperationsGrowthDetailSnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work(
            createOperationsGrowthDetailSnapshotReader(
              transaction.execute.bind(transaction)
            )
          ),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
  };
}

/**
 * 生产增长明细仓储；动态导入数据库以保持 DB-free Vitest。
 *
 * 副作用：首次调用时加载生产数据库模块并开启只读事务；数据库错误原样上抛。
 */
export const databaseOperationsGrowthDetailRepository: OperationsGrowthDetailRepository =
  {
    async withReadOnlySnapshot<T>(
      work: (reader: OperationsGrowthDetailSnapshotReader) => Promise<T>
    ): Promise<T> {
      const { db } = await import("@repo/database");
      return createOperationsGrowthDetailRepository(
        db as unknown as OperationsGrowthDetailTransactionDatabase
      ).withReadOnlySnapshot(work);
    },
  };
