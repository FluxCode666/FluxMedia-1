/**
 * 运营总览用户增长、活跃与注册 Cohort PostgreSQL 仓储。
 *
 * 使用方：增长领域服务。本文件在单个只读 repeatable-read 快照中
 * 捕获数据库时钟与 epoch，并让汇总、趋势和后续明细共享同一活跃事实定义。
 */
import {
  operationsAnalyticsEpoch,
  paymentOrder,
  user,
  userOutputUsageEvent,
  userWebVisit,
} from "@repo/database/schema";
import type { OperationsRangeBucket } from "@repo/shared/operations-dashboard/range";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import { toOperationsDatabaseTimestamp } from "./database-timestamp";
import type { OperationsDetailHighWatermarks } from "./detail-contracts";
import type {
  OperationsGrowthActivityKind,
  OperationsGrowthSnapshotHeader,
} from "./growth-contracts";

export type {
  OperationsGrowthActivityKind,
  OperationsGrowthSnapshotHeader,
} from "./growth-contracts";

/** 范围聚合共用的 UTC 半开边界。 */
export type OperationsGrowthRangeQuery = {
  start: Date;
  end: Date;
};

/** 查询趋势时传入的完整业务桶。 */
export type OperationsGrowthBucketQuery = Pick<
  OperationsRangeBucket,
  "key" | "dataFrom" | "end"
>;

/** 数据库返回的稀疏去重用户数。 */
export type OperationsGrowthSeriesRow = {
  bucketKey: string;
  userCount: number;
};

/** 单个注册日 Cohort 的人数与精确日创作留存分子。 */
export type OperationsGrowthCohortRow = {
  cohortDate: string;
  cohortSize: number;
  retainedD1: number;
  retainedD7: number;
  retainedD30: number;
};

/** Cohort SQL 需要的注册范围、行为截点和展示时区。 */
export type OperationsGrowthCohortQuery = {
  start: Date;
  end: Date;
  epochStart: Date;
  asOf: Date;
  timeZone: string;
};

/** 事务内所有用户增长读取的最小端口。 */
export interface OperationsGrowthSnapshotReader {
  readHeader(): Promise<OperationsGrowthSnapshotHeader>;
  readCumulativeUserCount(end: Date): Promise<number>;
  readNewUserCount(input: OperationsGrowthRangeQuery): Promise<number>;
  readActivityUserCount(
    kind: OperationsGrowthActivityKind,
    input: OperationsGrowthRangeQuery
  ): Promise<number>;
  readNewUserSeries(
    buckets: readonly OperationsGrowthBucketQuery[]
  ): Promise<OperationsGrowthSeriesRow[]>;
  readActivitySeries(
    kind: OperationsGrowthActivityKind,
    buckets: readonly OperationsGrowthBucketQuery[]
  ): Promise<OperationsGrowthSeriesRow[]>;
  readCohorts(
    input: OperationsGrowthCohortQuery
  ): Promise<OperationsGrowthCohortRow[]>;
}

/** 为整个增长快照建立唯一只读事务的仓储端口。 */
export interface OperationsGrowthRepository {
  withReadOnlySnapshot<T>(
    work: (reader: OperationsGrowthSnapshotReader) => Promise<T>
  ): Promise<T>;
}

type ExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与数据库集成测试共用的最小事务数据库端口。 */
export interface OperationsGrowthTransactionDatabase {
  transaction<T>(
    work: (transaction: { execute: ExecuteSql }) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ): Promise<T>;
}

const databaseDateSchema = z
  .union([z.date(), z.string().min(1)])
  .transform((value) => (value instanceof Date ? value : new Date(value)))
  .refine((value) => !Number.isNaN(value.getTime()), "数据库时间无效");
const databaseCountSchema = z.coerce.number().int().safe().nonnegative();
const snapshotHeaderRowSchema = z.object({
  as_of: databaseDateSchema,
  app_date: z.string().nullable(),
  starts_at: databaseDateSchema.nullable(),
});
const countRowSchema = z.object({ user_count: databaseCountSchema });
const seriesRowSchema = z.object({
  bucket_key: z.string(),
  user_count: databaseCountSchema,
});
const cohortRowSchema = z.object({
  cohort_date: z.string(),
  cohort_size: databaseCountSchema,
  retained_d1: databaseCountSchema,
  retained_d7: databaseCountSchema,
  retained_d30: databaseCountSchema,
});

/**
 * 构造增长快照的首条 SQL。
 *
 * @returns 总是返回一行；epoch 未初始化时两个 epoch 字段均为 null。
 */
export function buildOperationsGrowthHeaderSql(): SQL {
  return sql`
    select
      transaction_timestamp() as as_of,
      max(${operationsAnalyticsEpoch.appDate}) as app_date,
      max(${operationsAnalyticsEpoch.startsAt}) as starts_at
    from ${operationsAnalyticsEpoch}
    where ${operationsAnalyticsEpoch.id} = 1
  `;
}

/**
 * 构造截至指定时刻的累计账户数 SQL。
 *
 * WHY：不附加角色、封禁或 epoch 过滤，保留上线前存量账户基数。
 */
export function buildOperationsCumulativeUserCountSql(end: Date): SQL {
  return sql`
    select count(*) as user_count
    from ${user}
    where ${user.createdAt} < ${sql.param(end, user.createdAt)}
  `;
}

/** 构造范围内新增账户数 SQL，边界由服务层已截断到 epoch。 */
export function buildOperationsNewUserCountSql(
  input: OperationsGrowthRangeQuery
): SQL {
  return sql`
    select count(*) as user_count
    from ${user}
    where ${user.createdAt} >= ${sql.param(input.start, user.createdAt)}
      and ${user.createdAt} < ${sql.param(input.end, user.createdAt)}
  `;
}

/**
 * 构造某类活跃事实的标准两列数据源。
 *
 * @param kind 登录访问、成功创作或已履约充值。
 * @param start 已参数化的包含边界 SQL。
 * @param end 已参数化的排除边界 SQL。
 * @returns 统一投影为 user_id 和 business_time，供汇总、趋势和明细复用。
 */
export function buildOperationsActivitySourceSql(
  kind: OperationsGrowthActivityKind,
  start: SQL,
  end: SQL,
  highWatermarks?: OperationsDetailHighWatermarks
): SQL {
  if (kind === "login") {
    const watermark = highWatermarks?.webVisits;
    const bound = watermark
      ? sql`and (
          ${userWebVisit.createdAt},
          ${userWebVisit.userId},
          ${userWebVisit.appDate}
        ) <= (${toOperationsDatabaseTimestamp(watermark.createdAt)}, ${
          watermark.userId
        }, ${watermark.appDate})`
      : highWatermarks
        ? sql`and false`
        : sql``;
    return sql`
      select
        ${userWebVisit.userId} as user_id,
        ${userWebVisit.firstVisitedAt} as business_time
      from ${userWebVisit}
      where ${userWebVisit.firstVisitedAt} >= ${start}
        and ${userWebVisit.firstVisitedAt} < ${end}
        ${bound}
    `;
  }
  if (kind === "creation") {
    const watermark = highWatermarks?.outputs;
    const bound = watermark
      ? sql`and (
          ${userOutputUsageEvent.createdAt},
          ${userOutputUsageEvent.outputKind}::text,
          ${userOutputUsageEvent.sourceTaskId}
        ) <= (
          ${toOperationsDatabaseTimestamp(watermark.createdAt)},
          ${watermark.outputKind},
          ${watermark.sourceTaskId}
        )`
      : highWatermarks
        ? sql`and false`
        : sql``;
    return sql`
      select
        ${userOutputUsageEvent.userId} as user_id,
        ${userOutputUsageEvent.operationCreatedAt} as business_time
      from ${userOutputUsageEvent}
      where ${userOutputUsageEvent.operationCreatedAt} >= ${start}
        and ${userOutputUsageEvent.operationCreatedAt} < ${end}
        ${bound}
    `;
  }
  const watermark = highWatermarks?.paymentOrders;
  const bound = watermark
    ? sql`and (${paymentOrder.createdAt}, ${paymentOrder.id})
        <= (${toOperationsDatabaseTimestamp(watermark.createdAt)}, ${
          watermark.id
        })`
    : highWatermarks
      ? sql`and false`
      : sql``;
  return sql`
    select
      ${paymentOrder.userId} as user_id,
      ${paymentOrder.fulfilledAt} as business_time
    from ${paymentOrder}
    where ${paymentOrder.status} = 'fulfilled'
      and ${paymentOrder.purpose} in ('credit_top_up', 'credit_package')
      and ${paymentOrder.fulfilledAt} is not null
      and ${paymentOrder.fulfilledAt} >= ${start}
      and ${paymentOrder.fulfilledAt} < ${end}
      ${bound}
  `;
}

/** 构造周期内某类去重活跃用户数 SQL。 */
export function buildOperationsActivityUserCountSql(
  kind: OperationsGrowthActivityKind,
  input: OperationsGrowthRangeQuery
): SQL {
  const start = sql`${input.start}`;
  const end = sql`${input.end}`;
  return sql`
    with scoped_activity as (
      ${buildOperationsActivitySourceSql(kind, start, end)}
    )
    select count(distinct user_id) as user_count
    from scoped_activity
  `;
}

/**
 * 将可用桶编码为参数化 values CTE。
 *
 * @throws RangeError 没有可查询桶时拒绝构造无效 SQL。
 */
function buildBucketValuesSql(
  buckets: readonly OperationsGrowthBucketQuery[]
): SQL {
  const available = buckets.filter(
    (bucket): bucket is OperationsGrowthBucketQuery & { dataFrom: Date } =>
      bucket.dataFrom !== null
  );
  if (available.length === 0) {
    throw new RangeError("至少需要一个可查询的运营趋势桶");
  }
  return sql.join(
    available.map(
      (bucket) =>
        sql`(${bucket.key}::text, ${bucket.dataFrom}::timestamp, ${bucket.end}::timestamp)`
    ),
    sql`, `
  );
}

/** 构造新增用户稀疏趋势 SQL，每个账户只能落入一个不重叠桶。 */
export function buildOperationsNewUserSeriesSql(
  buckets: readonly OperationsGrowthBucketQuery[]
): SQL {
  const values = buildBucketValuesSql(buckets);
  return sql`
    with buckets(bucket_key, bucket_start, bucket_end) as (
      values ${values}
    )
    select
      buckets.bucket_key,
      count(${user.id}) as user_count
    from buckets
    join ${user}
      on ${user.createdAt} >= buckets.bucket_start
      and ${user.createdAt} < buckets.bucket_end
    group by buckets.bucket_key
    order by min(buckets.bucket_start)
  `;
}

/** 构造每个桶独立去重的活跃用户稀疏趋势 SQL。 */
export function buildOperationsActivitySeriesSql(
  kind: OperationsGrowthActivityKind,
  buckets: readonly OperationsGrowthBucketQuery[]
): SQL {
  const available = buckets.filter(
    (bucket): bucket is OperationsGrowthBucketQuery & { dataFrom: Date } =>
      bucket.dataFrom !== null
  );
  const values = buildBucketValuesSql(available);
  const earliest = available.reduce(
    (value, bucket) => (bucket.dataFrom < value ? bucket.dataFrom : value),
    available[0]?.dataFrom ?? new Date(0)
  );
  const latest = available.reduce(
    (value, bucket) => (bucket.end > value ? bucket.end : value),
    available[0]?.end ?? new Date(0)
  );
  return sql`
    with buckets(bucket_key, bucket_start, bucket_end) as (
      values ${values}
    ), scoped_activity as (
      ${buildOperationsActivitySourceSql(
        kind,
        sql`${earliest}`,
        sql`${latest}`
      )}
    )
    select
      buckets.bucket_key,
      count(distinct scoped_activity.user_id) as user_count
    from buckets
    join scoped_activity
      on scoped_activity.business_time >= buckets.bucket_start
      and scoped_activity.business_time < buckets.bucket_end
    group by buckets.bucket_key
    order by min(buckets.bucket_start)
  `;
}

/**
 * 构造按注册自然日聚合的 D1/D7/D30 精确创作留存 SQL。
 *
 * WHY：行为上限使用查询 asOf，不使用筛选范围结束时间，因此已成熟
 * Cohort 在范围结束后发生的目标日行为仍能被正确纳入。
 */
export function buildOperationsCohortSql(
  input: OperationsGrowthCohortQuery
): SQL {
  return sql`
    with cohort_users as (
      select
        ${user.id} as user_id,
        (
          (${user.createdAt} at time zone 'UTC') at time zone ${input.timeZone}
        )::date as cohort_date
      from ${user}
      where ${user.createdAt} >= ${sql.param(input.start, user.createdAt)}
        and ${user.createdAt} < ${sql.param(input.end, user.createdAt)}
        and ${user.createdAt} >= ${sql.param(input.epochStart, user.createdAt)}
    ), creation_days as (
      select distinct
        ${userOutputUsageEvent.userId} as user_id,
        (
          (${userOutputUsageEvent.operationCreatedAt} at time zone 'UTC')
            at time zone ${input.timeZone}
        )::date as activity_date
      from ${userOutputUsageEvent}
      join cohort_users
        on cohort_users.user_id = ${userOutputUsageEvent.userId}
      where ${userOutputUsageEvent.operationCreatedAt} >= ${sql.param(
        input.epochStart,
        userOutputUsageEvent.operationCreatedAt
      )}
        and ${userOutputUsageEvent.operationCreatedAt} < ${sql.param(
          input.asOf,
          userOutputUsageEvent.operationCreatedAt
        )}
    )
    select
      to_char(cohort_users.cohort_date, 'YYYY-MM-DD') as cohort_date,
      count(distinct cohort_users.user_id) as cohort_size,
      count(distinct cohort_users.user_id) filter (
        where creation_days.activity_date = cohort_users.cohort_date + 1
      ) as retained_d1,
      count(distinct cohort_users.user_id) filter (
        where creation_days.activity_date = cohort_users.cohort_date + 7
      ) as retained_d7,
      count(distinct cohort_users.user_id) filter (
        where creation_days.activity_date = cohort_users.cohort_date + 30
      ) as retained_d30
    from cohort_users
    left join creation_days
      on creation_days.user_id = cohort_users.user_id
      and creation_days.activity_date in (
        cohort_users.cohort_date + 1,
        cohort_users.cohort_date + 7,
        cohort_users.cohort_date + 30
      )
    group by cohort_users.cohort_date
    order by cohort_users.cohort_date
  `;
}

/** 从未信任的数据库结果读取唯一计数行。 */
function parseCount(result: unknown): number {
  const row = countRowSchema.parse(extractExecuteRows(result)[0]);
  return row.user_count;
}

/** 将数据库趋势行收窄为服务端口 DTO。 */
function parseSeries(result: unknown): OperationsGrowthSeriesRow[] {
  return z
    .array(seriesRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      bucketKey: row.bucket_key,
      userCount: row.user_count,
    }));
}

/** 将数据库 Cohort 行收窄为服务端口 DTO。 */
function parseCohorts(result: unknown): OperationsGrowthCohortRow[] {
  return z
    .array(cohortRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      cohortDate: row.cohort_date,
      cohortSize: row.cohort_size,
      retainedD1: row.retained_d1,
      retainedD7: row.retained_d7,
      retainedD30: row.retained_d30,
    }));
}

/** 把唯一事务 execute 绑定为增长快照 reader。 */
export function createOperationsGrowthSnapshotReader(
  execute: ExecuteSql
): OperationsGrowthSnapshotReader {
  return {
    async readHeader() {
      const row = snapshotHeaderRowSchema.parse(
        extractExecuteRows(await execute(buildOperationsGrowthHeaderSql()))[0]
      );
      if ((row.app_date === null) !== (row.starts_at === null)) {
        throw new Error("运营统计起点数据不完整");
      }
      return {
        asOf: row.as_of,
        epoch:
          row.app_date === null || row.starts_at === null
            ? null
            : { appDate: row.app_date, startsAt: row.starts_at },
      };
    },
    async readCumulativeUserCount(end) {
      return parseCount(
        await execute(buildOperationsCumulativeUserCountSql(end))
      );
    },
    async readNewUserCount(input) {
      return parseCount(await execute(buildOperationsNewUserCountSql(input)));
    },
    async readActivityUserCount(kind, input) {
      return parseCount(
        await execute(buildOperationsActivityUserCountSql(kind, input))
      );
    },
    async readNewUserSeries(buckets) {
      return buckets.some((bucket) => bucket.dataFrom !== null)
        ? parseSeries(await execute(buildOperationsNewUserSeriesSql(buckets)))
        : [];
    },
    async readActivitySeries(kind, buckets) {
      return buckets.some((bucket) => bucket.dataFrom !== null)
        ? parseSeries(
            await execute(buildOperationsActivitySeriesSql(kind, buckets))
          )
        : [];
    },
    async readCohorts(input) {
      return parseCohorts(await execute(buildOperationsCohortSql(input)));
    },
  };
}

/**
 * 从 Drizzle 类数据库端口创建增长快照仓储。
 *
 * @returns 每次调用使用只读 repeatable-read，防止页面指标与趋势跨快照。
 */
export function createOperationsGrowthRepository(
  database: OperationsGrowthTransactionDatabase
): OperationsGrowthRepository {
  return {
    withReadOnlySnapshot<T>(
      work: (reader: OperationsGrowthSnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work(
            createOperationsGrowthSnapshotReader(
              transaction.execute.bind(transaction)
            )
          ),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
  };
}

/** 生产仓储延迟导入数据库，保持 Web Vitest 在无 DATABASE_URL 时可注入内存端口。 */
export const databaseOperationsGrowthRepository: OperationsGrowthRepository = {
  async withReadOnlySnapshot<T>(
    work: (reader: OperationsGrowthSnapshotReader) => Promise<T>
  ): Promise<T> {
    const { db } = await import("@repo/database");
    const repository = createOperationsGrowthRepository(
      db as unknown as OperationsGrowthTransactionDatabase
    );
    return repository.withReadOnlySnapshot(work);
  },
};
