/**
 * 运营总览内容生产 PostgreSQL 仓储。
 *
 * 使用方：内容生产领域服务与后续统一 overview service。仓储在只读
 * repeatable-read 快照内读取成功产物事实，并按用户、媒体类型、任务 ID 和业务
 * 创建时间完整关联净积分 operation；免费成功任务合法贡献零积分。
 */
import {
  analyticsReadModelState,
  creditUsageOperation,
  operationsAnalyticsEpoch,
  userOutputUsageEvent,
} from "@repo/database/schema";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

import type {
  OperationsGrowthBucketQuery,
  OperationsGrowthSnapshotHeader,
} from "./growth-repository";

/** 单个读模型在事务首条查询中观察到的版本与状态。 */
export type OperationsContentReadModelState = {
  version: number;
  status: string;
} | null;

/** 内容快照首条读取捕获的时钟、epoch 与读模型 readiness。 */
export type OperationsContentSnapshotHeader = OperationsGrowthSnapshotHeader & {
  outputUsage: OperationsContentReadModelState;
  creditUsage: OperationsContentReadModelState;
};

/** 内容趋势的单个稀疏桶，积分以百分之一积分避免浮点聚合误差。 */
export type OperationsContentSeriesRow = {
  bucketKey: string;
  imageCount: number;
  videoCount: number;
  videoSeconds: number;
  creditHundredths: number;
  operationCreatedAtMismatchCount: number;
};

/** 事务内内容生产模块需要的全部只读方法。 */
export interface OperationsContentSnapshotReader {
  readHeader(): Promise<OperationsContentSnapshotHeader>;
  readSeries(
    buckets: readonly OperationsGrowthBucketQuery[]
  ): Promise<OperationsContentSeriesRow[]>;
}

/** 为内容生产模块建立唯一只读事务的仓储端口。 */
export interface OperationsContentRepository {
  withReadOnlySnapshot<T>(
    work: (reader: OperationsContentSnapshotReader) => Promise<T>
  ): Promise<T>;
}

type ExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与数据库集成测试共用的最小事务数据库端口。 */
export interface OperationsContentTransactionDatabase {
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
const readModelStatusSchema = z.enum([
  "building",
  "backfilling",
  "reconciling",
  "ready",
  "failed",
]);
const headerRowSchema = z.object({
  as_of: databaseDateSchema,
  app_date: z.string().nullable(),
  starts_at: databaseDateSchema.nullable(),
  output_version: databaseCountSchema.nullable(),
  output_status: readModelStatusSchema.nullable(),
  credit_version: databaseCountSchema.nullable(),
  credit_status: readModelStatusSchema.nullable(),
});
const seriesRowSchema = z.object({
  bucket_key: z.string(),
  image_count: databaseCountSchema,
  video_count: databaseCountSchema,
  video_seconds: databaseCountSchema,
  credit_hundredths: databaseCountSchema,
  operation_created_at_mismatch_count: databaseCountSchema,
});

/** 构造内容快照首条 SQL，固定数据库时钟、epoch 和两个读模型状态。 */
export function buildOperationsContentHeaderSql(): SQL {
  return sql`
    select
      transaction_timestamp() as as_of,
      max(${operationsAnalyticsEpoch.appDate}) as app_date,
      max(${operationsAnalyticsEpoch.startsAt}) as starts_at,
      (
        select max(${analyticsReadModelState.version})
        from ${analyticsReadModelState}
        where ${analyticsReadModelState.readModel} = 'output_usage'
      ) as output_version,
      (
        select max(${analyticsReadModelState.status}::text)
        from ${analyticsReadModelState}
        where ${analyticsReadModelState.readModel} = 'output_usage'
      ) as output_status,
      (
        select max(${analyticsReadModelState.version})
        from ${analyticsReadModelState}
        where ${analyticsReadModelState.readModel} = 'credit_usage'
      ) as credit_version,
      (
        select max(${analyticsReadModelState.status}::text)
        from ${analyticsReadModelState}
        where ${analyticsReadModelState.readModel} = 'credit_usage'
      ) as credit_status
    from ${operationsAnalyticsEpoch}
    where ${operationsAnalyticsEpoch.id} = 1
  `;
}

/**
 * 将存在可用数据的业务桶编码为参数化 values CTE。
 *
 * @throws RangeError 没有可查询桶时拒绝构造无效 SQL。
 */
function buildContentBucketValuesSql(
  buckets: readonly OperationsGrowthBucketQuery[]
): SQL {
  const available = buckets.filter(
    (bucket): bucket is OperationsGrowthBucketQuery & { dataFrom: Date } =>
      bucket.dataFrom !== null
  );
  if (available.length === 0) {
    throw new RangeError("至少需要一个可查询的内容趋势桶");
  }
  return sql.join(
    available.map(
      (bucket) =>
        sql`(${bucket.key}::text, ${bucket.dataFrom}::timestamp, ${bucket.end}::timestamp)`
    ),
    sql`, `
  );
}

/**
 * 构造成功图片、视频与净积分的稀疏趋势 SQL。
 *
 * WHY：查询必须由成功产物事实驱动。积分左连接包含 user_id、operation_type、
 * operation_id 和 operation_created_at 四个稳定身份字段；完全没有 operation 的
 * 免费任务贡献零，而前三项相同但业务创建时间不同会输出 mismatch 供服务拒绝。
 */
export function buildOperationsContentSeriesSql(
  buckets: readonly OperationsGrowthBucketQuery[]
): SQL {
  const values = buildContentBucketValuesSql(buckets);
  return sql`
    with buckets(bucket_key, bucket_start, bucket_end) as (
      values ${values}
    ), scoped_outputs as (
      select
        buckets.bucket_key,
        ${userOutputUsageEvent.outputKind} as output_kind,
        ${userOutputUsageEvent.sourceTaskId} as source_task_id,
        ${userOutputUsageEvent.userId} as user_id,
        ${userOutputUsageEvent.operationCreatedAt} as operation_created_at,
        ${userOutputUsageEvent.imageCount} as image_count,
        ${userOutputUsageEvent.videoSeconds} as video_seconds,
        case
          when ${userOutputUsageEvent.outputKind} = 'image'
            then 'image_generation'
          else 'video_generation'
        end as operation_type
      from buckets
      join ${userOutputUsageEvent}
        on ${userOutputUsageEvent.operationCreatedAt} >= buckets.bucket_start
        and ${userOutputUsageEvent.operationCreatedAt} < buckets.bucket_end
    )
    select
      scoped_outputs.bucket_key,
      coalesce(sum(scoped_outputs.image_count), 0) as image_count,
      count(*) filter (
        where scoped_outputs.output_kind = 'video'
      ) as video_count,
      coalesce(sum(scoped_outputs.video_seconds), 0) as video_seconds,
      coalesce(
        sum((coalesce(credit_lookup.net_consumed, 0) * 100)::bigint),
        0
      ) as credit_hundredths,
      count(*) filter (
        where credit_lookup.operation_id is null
          and exists (
            select 1
            from ${creditUsageOperation} as mismatch_lookup
            where mismatch_lookup.user_id = scoped_outputs.user_id
              and mismatch_lookup.operation_type
                = scoped_outputs.operation_type
              and mismatch_lookup.operation_id
                = scoped_outputs.source_task_id
              and mismatch_lookup.operation_created_at
                <> scoped_outputs.operation_created_at
          )
      ) as operation_created_at_mismatch_count
    from scoped_outputs
    left join ${creditUsageOperation} as credit_lookup
      on credit_lookup.user_id = scoped_outputs.user_id
      and credit_lookup.operation_type = scoped_outputs.operation_type
      and credit_lookup.operation_id = scoped_outputs.source_task_id
      and credit_lookup.operation_created_at
        = scoped_outputs.operation_created_at
    group by scoped_outputs.bucket_key
    order by min(scoped_outputs.operation_created_at)
  `;
}

/** 将数据库读模型状态字段配对为服务 DTO，拒绝半缺失数据。 */
function parseReadModelState(
  version: number | null,
  status: z.infer<typeof readModelStatusSchema> | null,
  name: string
): OperationsContentReadModelState {
  if ((version === null) !== (status === null)) {
    throw new Error(`${name}读模型状态不完整`);
  }
  return version === null || status === null ? null : { version, status };
}

/** 将数据库稀疏趋势行收窄为内容服务 DTO。 */
function parseContentSeries(result: unknown): OperationsContentSeriesRow[] {
  return z
    .array(seriesRowSchema)
    .parse(extractExecuteRows(result))
    .map((row) => ({
      bucketKey: row.bucket_key,
      imageCount: row.image_count,
      videoCount: row.video_count,
      videoSeconds: row.video_seconds,
      creditHundredths: row.credit_hundredths,
      operationCreatedAtMismatchCount: row.operation_created_at_mismatch_count,
    }));
}

/** 把唯一事务 execute 绑定为内容生产快照 reader。 */
export function createOperationsContentSnapshotReader(
  execute: ExecuteSql
): OperationsContentSnapshotReader {
  return {
    async readHeader() {
      const row = headerRowSchema.parse(
        extractExecuteRows(await execute(buildOperationsContentHeaderSql()))[0]
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
        outputUsage: parseReadModelState(
          row.output_version,
          row.output_status,
          "output_usage"
        ),
        creditUsage: parseReadModelState(
          row.credit_version,
          row.credit_status,
          "credit_usage"
        ),
      };
    },
    async readSeries(buckets) {
      return buckets.some((bucket) => bucket.dataFrom !== null)
        ? parseContentSeries(
            await execute(buildOperationsContentSeriesSql(buckets))
          )
        : [];
    },
  };
}

/** 从 Drizzle 类数据库端口创建内容生产快照仓储。 */
export function createOperationsContentRepository(
  database: OperationsContentTransactionDatabase
): OperationsContentRepository {
  return {
    withReadOnlySnapshot<T>(
      work: (reader: OperationsContentSnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work(createOperationsContentSnapshotReader(transaction.execute)),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
  };
}

/** 生产仓储延迟导入数据库，使 Web Vitest 可在无 DATABASE_URL 下注入 reader。 */
export const databaseOperationsContentRepository: OperationsContentRepository =
  {
    async withReadOnlySnapshot<T>(
      work: (reader: OperationsContentSnapshotReader) => Promise<T>
    ): Promise<T> {
      const { db } = await import("@repo/database");
      const repository = createOperationsContentRepository(
        db as unknown as OperationsContentTransactionDatabase
      );
      return repository.withReadOnlySnapshot(work);
    },
  };
