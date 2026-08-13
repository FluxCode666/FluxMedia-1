/**
 * 运营总览用户增长明细 PostgreSQL 仓储。
 *
 * 使用方：后续 operations detail UOL 与 CSV worker。新增用户、三类活跃和
 * Cohort 明细与汇总仓储复用同一活跃事实构造器，并使用 business_time + user_id
 * 降序 keyset；完整邮箱仅能由后续 human-only 管理员 operation 暴露。
 */
import { user, userOutputUsageEvent } from "@repo/database/schema";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

import {
  buildOperationsActivitySourceSql,
  createOperationsGrowthSnapshotReader,
  type OperationsGrowthActivityKind,
  type OperationsGrowthSnapshotHeader,
} from "./growth-repository";

/** 明细排序键；同一业务时间以用户 ID 稳定打破平局。 */
export type OperationsGrowthDetailCursor = {
  businessTime: Date;
  stableId: string;
};

type OperationsGrowthDetailBaseQuery = {
  start: Date;
  end: Date;
  epochStart: Date;
  asOf: Date;
  cursor: OperationsGrowthDetailCursor | null;
  limit: number;
};

/** 新增账户明细查询，范围必须已在服务层截断至 epoch。 */
export type OperationsNewUserDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "users";
};

/** 周期活跃明细每用户只返回一行，因而行数可直接反算去重汇总。 */
export type OperationsActivityDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "activity";
  activityKind: OperationsGrowthActivityKind;
};

/** 单个注册日与精确目标日的 Cohort 明细查询。 */
export type OperationsCohortDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "cohort";
  targetStart: Date;
  targetEnd: Date;
};

/** 增长明细的封闭查询类型。 */
export type OperationsGrowthDetailQuery =
  | OperationsNewUserDetailQuery
  | OperationsActivityDetailQuery
  | OperationsCohortDetailQuery;

/** 可用汇总反算的最小用户明细行。 */
export type OperationsGrowthDetailRow = {
  userId: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  businessTime: Date;
  retained: boolean | null;
};

/** 带 keyset 继续信息的增长明细页。 */
export type OperationsGrowthDetailPage = {
  rows: OperationsGrowthDetailRow[];
  nextCursor: OperationsGrowthDetailCursor | null;
};

/** 单个只读快照中的增长明细读取端口。 */
export interface OperationsGrowthDetailSnapshotReader {
  readHeader(): Promise<OperationsGrowthSnapshotHeader>;
  readRows(
    input: OperationsGrowthDetailQuery
  ): Promise<OperationsGrowthDetailRow[]>;
}

/** 增长明细仓储端口；limit 应包含服务层用于判断下一页的额外一行。 */
export interface OperationsGrowthDetailRepository {
  withReadOnlySnapshot<T>(
    work: (reader: OperationsGrowthDetailSnapshotReader) => Promise<T>
  ): Promise<T>;
}

type ExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与集成测试共用的最小只读事务数据库端口。 */
export interface OperationsGrowthDetailTransactionDatabase {
  transaction<T>(
    work: (transaction: { execute: ExecuteSql }) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ): Promise<T>;
}

const detailDatabaseRowSchema = z.object({
  user_id: z.string().min(1),
  name: z.string(),
  email: z.string().email(),
  role: z.string().min(1),
  banned: z.boolean(),
  business_time: z
    .union([z.date(), z.string().min(1)])
    .transform((value) => (value instanceof Date ? value : new Date(value)))
    .refine((value) => !Number.isNaN(value.getTime()), "明细业务时间无效"),
  retained: z.boolean().nullable(),
});

/** 对内部明细查询进行资源与边界防御，避免导出 worker 误用无界读取。 */
function assertValidDetailQuery(input: OperationsGrowthDetailQuery): void {
  const validDates = [
    input.start,
    input.end,
    input.epochStart,
    input.asOf,
  ].every((value) => !Number.isNaN(value.getTime()));
  if (
    !validDates ||
    input.start >= input.end ||
    input.start < input.epochStart ||
    input.end > input.asOf ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 10_001
  ) {
    throw new RangeError("运营增长明细查询无效");
  }
  if (
    input.cursor &&
    (Number.isNaN(input.cursor.businessTime.getTime()) ||
      input.cursor.stableId.length === 0 ||
      input.cursor.stableId.length > 512)
  ) {
    throw new RangeError("运营增长明细游标无效");
  }
  if (
    input.kind === "cohort" &&
    (Number.isNaN(input.targetStart.getTime()) ||
      Number.isNaN(input.targetEnd.getTime()) ||
      input.targetStart >= input.targetEnd ||
      input.targetEnd > input.asOf)
  ) {
    throw new RangeError("Cohort 目标日范围无效");
  }
}

/** 构造原始业务时间和主键上的降序 keyset 谓词。 */
function buildDetailKeysetPredicate(
  cursor: OperationsGrowthDetailCursor | null,
  businessTime: SQL,
  stableId: SQL
): SQL {
  if (!cursor) return sql`true`;
  return sql`(
    ${businessTime} < ${cursor.businessTime}
    or (
      ${businessTime} = ${cursor.businessTime}
      and ${stableId} < ${cursor.stableId}
    )
  )`;
}

/** 构造新增账户明细 SQL，不排除管理员、观察员或封禁账户。 */
export function buildOperationsNewUserDetailSql(
  input: OperationsNewUserDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sql`${user.createdAt}`,
    sql`${user.id}`
  );
  return sql`
    select
      ${user.id} as user_id,
      ${user.name} as name,
      ${user.email} as email,
      ${user.role}::text as role,
      ${user.banned} as banned,
      ${user.createdAt} as business_time,
      null::boolean as retained
    from ${user}
    where ${user.createdAt} >= ${sql.param(input.start, user.createdAt)}
      and ${user.createdAt} < ${sql.param(input.end, user.createdAt)}
      and ${user.createdAt} >= ${sql.param(input.epochStart, user.createdAt)}
      and ${user.createdAt} <= ${sql.param(input.asOf, user.createdAt)}
      and ${keyset}
    order by ${user.createdAt} desc, ${user.id} desc
    limit ${input.limit}
  `;
}

/**
 * 构造活跃用户明细 SQL。
 *
 * WHY：先使用汇总的同源事实谓词收窄，再每用户取范围内首次业务时间；
 * 因此明细行数精确等于 COUNT(DISTINCT user_id)。
 */
export function buildOperationsActivityDetailSql(
  input: OperationsActivityDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const activitySource = buildOperationsActivitySourceSql(
    input.activityKind,
    sql`${input.start}`,
    sql`${input.end}`
  );
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sql`activity_users.business_time`,
    sql`activity_users.user_id`
  );
  return sql`
    with scoped_activity as (
      ${activitySource}
    ), activity_users as (
      select
        scoped_activity.user_id,
        min(scoped_activity.business_time) as business_time
      from scoped_activity
      group by scoped_activity.user_id
    )
    select
      activity_users.user_id,
      ${user.name} as name,
      ${user.email} as email,
      ${user.role}::text as role,
      ${user.banned} as banned,
      activity_users.business_time,
      null::boolean as retained
    from activity_users
    join ${user} on ${user.id} = activity_users.user_id
    where activity_users.business_time <= ${input.asOf}
      and ${keyset}
    order by activity_users.business_time desc, activity_users.user_id desc
    limit ${input.limit}
  `;
}

/**
 * 构造 Cohort 用户明细 SQL，每个注册用户一行并投影目标日是否成功创作。
 *
 * 行数反算 cohort_size，retained=true 行数反算指定 D1/D7/D30 分子。
 */
export function buildOperationsCohortDetailSql(
  input: OperationsCohortDetailQuery
): SQL {
  assertValidDetailQuery(input);
  const keyset = buildDetailKeysetPredicate(
    input.cursor,
    sql`${user.createdAt}`,
    sql`${user.id}`
  );
  return sql`
    select
      ${user.id} as user_id,
      ${user.name} as name,
      ${user.email} as email,
      ${user.role}::text as role,
      ${user.banned} as banned,
      ${user.createdAt} as business_time,
      exists (
        select 1
        from ${userOutputUsageEvent}
        where ${userOutputUsageEvent.userId} = ${user.id}
          and ${userOutputUsageEvent.operationCreatedAt} >= ${sql.param(
            input.targetStart,
            userOutputUsageEvent.operationCreatedAt
          )}
          and ${userOutputUsageEvent.operationCreatedAt} < ${sql.param(
            input.targetEnd,
            userOutputUsageEvent.operationCreatedAt
          )}
      ) as retained
    from ${user}
    where ${user.createdAt} >= ${sql.param(input.start, user.createdAt)}
      and ${user.createdAt} < ${sql.param(input.end, user.createdAt)}
      and ${user.createdAt} >= ${sql.param(input.epochStart, user.createdAt)}
      and ${user.createdAt} <= ${sql.param(input.asOf, user.createdAt)}
      and ${keyset}
    order by ${user.createdAt} desc, ${user.id} desc
    limit ${input.limit}
  `;
}

/** 根据封闭查询类型选择对应 SQL，未知类型无法在 TypeScript strict 下编译。 */
export function buildOperationsGrowthDetailSql(
  input: OperationsGrowthDetailQuery
): SQL {
  if (input.kind === "users") return buildOperationsNewUserDetailSql(input);
  if (input.kind === "activity") {
    return buildOperationsActivityDetailSql(input);
  }
  return buildOperationsCohortDetailSql(input);
}

/**
 * 将 limit+1 仓储行切分为当页与下一页 keyset。
 *
 * @param rows 仓储按 business_time、user_id 降序返回的原始行。
 * @param pageSize 对外页大小，仓储查询 limit 应等于 pageSize + 1。
 * @returns 最多 pageSize 行；仅存在额外行时签发原始结构游标。
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
            stableId: lastRow.userId,
          }
        : null,
  };
}

/** 将不可信数据库行严格收窄为增长明细 DTO。 */
function parseDetailRows(result: unknown): OperationsGrowthDetailRow[] {
  return z
    .array(detailDatabaseRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      role: row.role,
      banned: row.banned,
      businessTime: row.business_time,
      retained: row.retained,
    }));
}

/** 将唯一事务 execute 绑定为明细与快照头的组合 reader。 */
function createOperationsGrowthDetailSnapshotReader(
  execute: ExecuteSql
): OperationsGrowthDetailSnapshotReader {
  const growthReader = createOperationsGrowthSnapshotReader(execute);
  return {
    readHeader: growthReader.readHeader,
    async readRows(input) {
      return parseDetailRows(
        await execute(buildOperationsGrowthDetailSql(input))
      );
    },
  };
}

/** 从 Drizzle 类数据库端口创建单一 repeatable-read 明细仓储。 */
export function createOperationsGrowthDetailRepository(
  database: OperationsGrowthDetailTransactionDatabase
): OperationsGrowthDetailRepository {
  return {
    withReadOnlySnapshot<T>(
      work: (reader: OperationsGrowthDetailSnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work(createOperationsGrowthDetailSnapshotReader(transaction.execute)),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
  };
}

/** 生产增长明细仓储；动态导入数据库以保持 DB-free Vitest。 */
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
