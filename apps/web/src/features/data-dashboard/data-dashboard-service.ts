/**
 * 用户数据看板的一致快照聚合服务。
 *
 * UOL binding 传入用户 ID（用户看板）或空用户 ID（管理员全局看板）、有效时区与
 * strict 原始范围；服务在一个只读 repeatable-read 事务内先读取 readiness 和数据库
 * 时钟，再执行四类有界聚合，最后用 shared schema 复核整页 DTO。Web 适配层不得绕过
 * 本服务直接拼装指标。
 */
import {
  analyticsReadModelState,
  creditUsageOperation,
  generation,
  userOutputUsageEvent,
  videoGeneration,
} from "@repo/database/schema";
import {
  type DataDashboardBucket,
  type DataDashboardOutput,
  dataDashboardOutputSchema,
} from "@repo/shared/analytics/contracts";
import {
  type ResolvedDataDashboardRange,
  resolveDataDashboardRange,
} from "@repo/shared/analytics/data-dashboard-range";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { extractExecuteRows } from "@/server/database-result";

/** 聚合服务对 binding 暴露的稳定错误分类。 */
export type DataDashboardServiceErrorCode =
  | "validation_error"
  | "not_ready"
  | "invalid_data";

/**
 * 表示可安全映射为 UOL 错误的看板服务失败。
 *
 * 数据库连接、超时等未知异常不会被包成此类型，交由上层统一记录并降级为 unavailable。
 */
export class DataDashboardServiceError extends Error {
  readonly code: DataDashboardServiceErrorCode;

  /**
   * @param code 稳定错误分类。
   * @param message 不包含用户内容或数据库行的安全说明。
   */
  constructor(code: DataDashboardServiceErrorCode, message: string) {
    super(message);
    this.name = "DataDashboardServiceError";
    this.code = code;
  }
}

/** 单个读模型在事务首条 SQL 中观察到的版本与状态。 */
export type DataDashboardReadModelState = {
  version: number;
  status: string;
} | null;

/** 同一事务快照捕获的 readiness 与唯一数据库时钟。 */
export type DataDashboardSnapshotHeader = {
  asOf: Date;
  outputUsage: DataDashboardReadModelState;
  creditUsage: DataDashboardReadModelState;
};

/** 四类范围查询共用的可选用户作用域、UTC 半开边界和展示时区。 */
export type DataDashboardRangeQuery = {
  /** 为空表示管理员全局范围；非空时严格限定单个用户。 */
  userId?: string;
  start: Date;
  end: Date;
  timeZone: string;
};

/** 成功产物的单个稀疏自然日聚合行。 */
export type DataDashboardSuccessBucketRow = {
  date: string;
  imageCount: number;
  imageTaskCount: number;
  videoCount: number;
  videoSeconds: number;
};

/** 成功产物关联计费 operation 的单个稀疏自然日聚合行。 */
export type DataDashboardCreditBucketRow = {
  date: string;
  creditsConsumed: number;
  operationCreatedAtMismatchCount: number;
};

/** 成功任务按规范模型 ID 聚合的任务数。 */
export type DataDashboardModelUsageRow = {
  model: string;
  taskCount: number;
};

/** 范围内失败媒体任务与成功事件冲突摘要。 */
export type DataDashboardFailedTaskSummary = {
  imageFailedCount: number;
  videoFailedCount: number;
  successOverlapCount: number;
};

/**
 * 事务内最小读取端口。
 *
 * 所有方法必须绑定同一 transaction handle；服务按声明顺序串行调用以保证首条
 * readiness 门禁在任何业务聚合之前完成。
 */
export interface DataDashboardSnapshotReader {
  readSnapshotHeader: () => Promise<DataDashboardSnapshotHeader>;
  readSuccessBuckets: (
    input: DataDashboardRangeQuery
  ) => Promise<DataDashboardSuccessBucketRow[]>;
  readCreditBuckets: (
    input: DataDashboardRangeQuery
  ) => Promise<DataDashboardCreditBucketRow[]>;
  readModelUsage: (
    input: DataDashboardRangeQuery
  ) => Promise<DataDashboardModelUsageRow[]>;
  readFailedTasks: (
    input: DataDashboardRangeQuery
  ) => Promise<DataDashboardFailedTaskSummary>;
}

/** 创建 read-only repeatable-read 快照并把唯一 reader 交给领域服务的仓储端口。 */
export interface DataDashboardSnapshotRepository {
  withReadOnlySnapshot: <T>(
    work: (reader: DataDashboardSnapshotReader) => Promise<T>
  ) => Promise<T>;
}

type LoadDataDashboardSnapshotInput = {
  /** 为空表示管理员全局看板；非空表示用户本人看板。 */
  userId?: string;
  timeZone: string;
  rangeInput: unknown;
};

type ExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与 PostgreSQL 集成测试共用的最小事务执行端口。 */
export interface DataDashboardTransactionDatabase {
  transaction: <T>(
    work: (transaction: { execute: ExecuteSql }) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ) => Promise<T>;
}

const databaseDateSchema = z
  .union([z.date(), z.string().min(1)])
  .transform((value) => (value instanceof Date ? value : new Date(value)))
  .refine((value) => !Number.isNaN(value.getTime()), "数据库时间无效");
const databaseIntegerSchema = z.coerce.number().int().safe().nonnegative();
const databaseCreditsSchema = z.coerce.number().finite().nonnegative();
const readModelStatusSchema = z.enum([
  "building",
  "backfilling",
  "reconciling",
  "ready",
  "failed",
]);

const snapshotHeaderRowSchema = z.object({
  as_of: databaseDateSchema,
  output_version: databaseIntegerSchema.nullable(),
  output_status: readModelStatusSchema.nullable(),
  credit_version: databaseIntegerSchema.nullable(),
  credit_status: readModelStatusSchema.nullable(),
});

const successBucketDatabaseRowSchema = z.object({
  bucket_date: z.string(),
  image_count: databaseIntegerSchema,
  image_task_count: databaseIntegerSchema,
  video_count: databaseIntegerSchema,
  video_seconds: databaseIntegerSchema,
});

const creditBucketDatabaseRowSchema = z.object({
  bucket_date: z.string(),
  credits_consumed: databaseCreditsSchema,
  operation_created_at_mismatch_count: databaseIntegerSchema,
});

const modelUsageDatabaseRowSchema = z.object({
  model: z.string(),
  task_count: databaseIntegerSchema,
});

const failedTaskDatabaseRowSchema = z.object({
  image_failed_count: databaseIntegerSchema,
  video_failed_count: databaseIntegerSchema,
  success_overlap_count: databaseIntegerSchema,
});

/**
 * 构造事务第一条 readiness 与数据库时钟查询。
 *
 * @returns 即使两条状态都缺失也返回一行的过滤聚合 SQL。
 */
export function buildDataDashboardSnapshotHeaderSql(): SQL {
  return sql`
    select
      transaction_timestamp() as as_of,
      max(${analyticsReadModelState.version}) filter (
        where ${analyticsReadModelState.readModel} = 'output_usage'
      ) as output_version,
      max(${analyticsReadModelState.status}::text) filter (
        where ${analyticsReadModelState.readModel} = 'output_usage'
      ) as output_status,
      max(${analyticsReadModelState.version}) filter (
        where ${analyticsReadModelState.readModel} = 'credit_usage'
      ) as credit_version,
      max(${analyticsReadModelState.status}::text) filter (
        where ${analyticsReadModelState.readModel} = 'credit_usage'
      ) as credit_status
    from ${analyticsReadModelState}
    where ${analyticsReadModelState.readModel}
      in ('output_usage', 'credit_usage')
  `;
}

/**
 * 构造成功产物逐日聚合 SQL。
 *
 * @param input 可选用户作用域、展示时区与已验证 UTC 半开范围。
 * @returns 扫描全局或本人事件时间索引的单次有界查询。
 */
export function buildDataDashboardSuccessBucketsSql(
  input: DataDashboardRangeQuery
): SQL {
  const start = sql.param(input.start, userOutputUsageEvent.operationCreatedAt);
  const end = sql.param(input.end, userOutputUsageEvent.operationCreatedAt);
  const userScope =
    input.userId !== undefined
      ? sql`and ${userOutputUsageEvent.userId} = ${input.userId}`
      : sql``;
  return sql`
    with scoped_success as (
      select
        (
          (${userOutputUsageEvent.operationCreatedAt} at time zone 'UTC')
            at time zone ${input.timeZone}
        )::date as bucket_date,
        ${userOutputUsageEvent.outputKind} as output_kind,
        ${userOutputUsageEvent.imageCount} as image_count,
        ${userOutputUsageEvent.videoSeconds} as video_seconds
      from ${userOutputUsageEvent}
      where ${userOutputUsageEvent.operationCreatedAt} >= ${start}
        and ${userOutputUsageEvent.operationCreatedAt} < ${end}
        ${userScope}
    )
    select
      to_char(bucket_date, 'YYYY-MM-DD') as bucket_date,
      coalesce(sum(image_count), 0) as image_count,
      count(*) filter (where output_kind = 'image') as image_task_count,
      count(*) filter (where output_kind = 'video') as video_count,
      coalesce(sum(video_seconds), 0) as video_seconds
    from scoped_success
    group by bucket_date
    order by bucket_date
  `;
}

/**
 * 构造成功产物关联净积分逐日聚合 SQL。
 *
 * @param input 可选用户作用域、展示时区与已验证 UTC 半开范围。
 * @returns 由成功事件驱动的左连接查询；免费任务没有 operation 时贡献 0。
 */
export function buildDataDashboardCreditBucketsSql(
  input: DataDashboardRangeQuery
): SQL {
  const start = sql.param(input.start, userOutputUsageEvent.operationCreatedAt);
  const end = sql.param(input.end, userOutputUsageEvent.operationCreatedAt);
  const userScope =
    input.userId !== undefined
      ? sql`and ${userOutputUsageEvent.userId} = ${input.userId}`
      : sql``;
  return sql`
    with scoped_credits as (
      select
        (
          (${userOutputUsageEvent.operationCreatedAt} at time zone 'UTC')
            at time zone ${input.timeZone}
        )::date as bucket_date,
        coalesce(credit_lookup.net_consumed, 0) as net_consumed,
        case
          when credit_lookup.operation_id is not null
            and credit_lookup.operation_created_at
              <> ${userOutputUsageEvent.operationCreatedAt}
          then 1
          when credit_lookup.operation_id is null
            and exists (
              select 1
              from ${creditUsageOperation} as mismatch_lookup
              where mismatch_lookup.user_id = ${userOutputUsageEvent.userId}
                and mismatch_lookup.operation_id
                  = ${userOutputUsageEvent.sourceTaskId}
                and mismatch_lookup.operation_type = case
                  when ${userOutputUsageEvent.outputKind} = 'image'
                    then 'image_generation'
                  else 'video_generation'
                end
            )
          then 1
          else 0
        end as operation_created_at_mismatch
      from ${userOutputUsageEvent}
      left join ${creditUsageOperation} as credit_lookup
        on credit_lookup.user_id = ${userOutputUsageEvent.userId}
        and credit_lookup.operation_id
          = ${userOutputUsageEvent.sourceTaskId}
        and credit_lookup.operation_type = case
          when ${userOutputUsageEvent.outputKind} = 'image'
            then 'image_generation'
          else 'video_generation'
        end
        and credit_lookup.operation_created_at >= ${start}
        and credit_lookup.operation_created_at < ${end}
      where ${userOutputUsageEvent.operationCreatedAt} >= ${start}
        and ${userOutputUsageEvent.operationCreatedAt} < ${end}
        ${userScope}
    )
    select
      to_char(bucket_date, 'YYYY-MM-DD') as bucket_date,
      coalesce(sum(net_consumed), 0) as credits_consumed,
      coalesce(sum(operation_created_at_mismatch), 0)
        as operation_created_at_mismatch_count
    from scoped_credits
    group by bucket_date
    order by bucket_date
  `;
}

/**
 * 构造成功任务模型分布 SQL。
 *
 * @param input 可选用户作用域、展示时区与已验证 UTC 半开范围。
 * @returns 每个成功事件恰好归入一个真实模型或 unknown 分类的有界查询。
 */
export function buildDataDashboardModelUsageSql(
  input: DataDashboardRangeQuery
): SQL {
  const start = sql.param(input.start, userOutputUsageEvent.operationCreatedAt);
  const end = sql.param(input.end, userOutputUsageEvent.operationCreatedAt);
  const imageStart = sql.param(input.start, generation.createdAt);
  const imageEnd = sql.param(input.end, generation.createdAt);
  const videoStart = sql.param(input.start, videoGeneration.createdAt);
  const videoEnd = sql.param(input.end, videoGeneration.createdAt);
  const userScope =
    input.userId !== undefined
      ? sql`and ${userOutputUsageEvent.userId} = ${input.userId}`
      : sql``;
  return sql`
    select
      coalesce(
        nullif(trim(case
          when ${userOutputUsageEvent.outputKind} = 'image'
            then ${generation.model}
          else ${videoGeneration.model}
        end), ''),
        'unknown'
      ) as model,
      count(*) as task_count
    from ${userOutputUsageEvent}
    left join ${generation}
      on ${userOutputUsageEvent.outputKind} = 'image'
      and ${userOutputUsageEvent.sourceTaskId} = ${generation.id}
      and ${userOutputUsageEvent.userId} = ${generation.userId}
      and ${generation.createdAt} >= ${imageStart}
      and ${generation.createdAt} < ${imageEnd}
    left join ${videoGeneration}
      on ${userOutputUsageEvent.outputKind} = 'video'
      and ${userOutputUsageEvent.sourceTaskId} = ${videoGeneration.id}
      and ${userOutputUsageEvent.userId} = ${videoGeneration.userId}
      and ${videoGeneration.createdAt} >= ${videoStart}
      and ${videoGeneration.createdAt} < ${videoEnd}
    where ${userOutputUsageEvent.operationCreatedAt} >= ${start}
      and ${userOutputUsageEvent.operationCreatedAt} < ${end}
      ${userScope}
    group by 1
    order by task_count desc, model asc
  `;
}

/**
 * 构造失败媒体任务与成功事件冲突查询。
 *
 * @param input 可选用户作用域、展示时区与已验证 UTC 半开范围。
 * @returns 图片 generate/edit 与视频 failed 任务数；重叠检测不限制事件日期。
 */
export function buildDataDashboardFailedTasksSql(
  input: DataDashboardRangeQuery
): SQL {
  const imageStart = sql.param(input.start, generation.createdAt);
  const imageEnd = sql.param(input.end, generation.createdAt);
  const videoStart = sql.param(input.start, videoGeneration.createdAt);
  const videoEnd = sql.param(input.end, videoGeneration.createdAt);
  const imageUserScope =
    input.userId !== undefined
      ? sql`and ${generation.userId} = ${input.userId}`
      : sql``;
  const videoUserScope =
    input.userId !== undefined
      ? sql`and ${videoGeneration.userId} = ${input.userId}`
      : sql``;
  const successUserScope =
    input.userId !== undefined
      ? sql`and ${userOutputUsageEvent.userId} = ${input.userId}`
      : sql``;
  return sql`
    with failed_tasks as (
      select
        'image'::text as output_kind,
        ${generation.id} as source_task_id
      from ${generation}
      where ${generation.createdAt} >= ${imageStart}
        and ${generation.createdAt} < ${imageEnd}
        and ${generation.status} = 'failed'
        and coalesce(
          nullif(lower(btrim(${generation.metadata}->>'mode')), ''),
          'generate'
        ) in ('generate', 'edit')
        ${imageUserScope}
      union all
      select
        'video'::text as output_kind,
        ${videoGeneration.id} as source_task_id
      from ${videoGeneration}
      where ${videoGeneration.createdAt} >= ${videoStart}
        and ${videoGeneration.createdAt} < ${videoEnd}
        and ${videoGeneration.status} = 'failed'
        ${videoUserScope}
    )
    select
      count(*) filter (where failed_tasks.output_kind = 'image')
        as image_failed_count,
      count(*) filter (where failed_tasks.output_kind = 'video')
        as video_failed_count,
      count(${userOutputUsageEvent.sourceTaskId}) as success_overlap_count
    from failed_tasks
    left join ${userOutputUsageEvent}
      on ${userOutputUsageEvent.outputKind}::text = failed_tasks.output_kind
      and ${userOutputUsageEvent.sourceTaskId} = failed_tasks.source_task_id
      ${successUserScope}
  `;
}

/** 将首条原始 SQL 行收窄为快照 header；缺少聚合行视为读模型损坏。 */
async function readSnapshotHeader(
  execute: ExecuteSql
): Promise<DataDashboardSnapshotHeader> {
  const [rawRow] = extractExecuteRows(
    await execute(buildDataDashboardSnapshotHeaderSql())
  );
  if (!rawRow) {
    throw new DataDashboardServiceError("invalid_data", "数据看板快照头缺失");
  }
  const row = snapshotHeaderRowSchema.parse(rawRow);
  return {
    asOf: row.as_of,
    outputUsage:
      row.output_version === null || row.output_status === null
        ? null
        : { version: row.output_version, status: row.output_status },
    creditUsage:
      row.credit_version === null || row.credit_status === null
        ? null
        : { version: row.credit_version, status: row.credit_status },
  };
}

/** 执行并收窄成功产物日桶 SQL。 */
async function readSuccessBuckets(
  execute: ExecuteSql,
  input: DataDashboardRangeQuery
): Promise<DataDashboardSuccessBucketRow[]> {
  return z
    .array(successBucketDatabaseRowSchema)
    .parse(
      extractExecuteRows(
        await execute(buildDataDashboardSuccessBucketsSql(input))
      )
    )
    .map((row) => ({
      date: row.bucket_date,
      imageCount: row.image_count,
      imageTaskCount: row.image_task_count,
      videoCount: row.video_count,
      videoSeconds: row.video_seconds,
    }));
}

/** 执行并收窄成功产物关联积分日桶 SQL。 */
async function readCreditBuckets(
  execute: ExecuteSql,
  input: DataDashboardRangeQuery
): Promise<DataDashboardCreditBucketRow[]> {
  return z
    .array(creditBucketDatabaseRowSchema)
    .parse(
      extractExecuteRows(
        await execute(buildDataDashboardCreditBucketsSql(input))
      )
    )
    .map((row) => ({
      date: row.bucket_date,
      creditsConsumed: row.credits_consumed,
      operationCreatedAtMismatchCount: row.operation_created_at_mismatch_count,
    }));
}

/** 执行并收窄成功任务模型 SQL。 */
async function readModelUsage(
  execute: ExecuteSql,
  input: DataDashboardRangeQuery
): Promise<DataDashboardModelUsageRow[]> {
  return z
    .array(modelUsageDatabaseRowSchema)
    .parse(
      extractExecuteRows(await execute(buildDataDashboardModelUsageSql(input)))
    )
    .map((row) => ({ model: row.model, taskCount: row.task_count }));
}

/** 执行并收窄失败任务与成功重叠摘要 SQL。 */
async function readFailedTasks(
  execute: ExecuteSql,
  input: DataDashboardRangeQuery
): Promise<DataDashboardFailedTaskSummary> {
  const [row] = z
    .array(failedTaskDatabaseRowSchema)
    .parse(
      extractExecuteRows(await execute(buildDataDashboardFailedTasksSql(input)))
    );
  return row
    ? {
        imageFailedCount: row.image_failed_count,
        videoFailedCount: row.video_failed_count,
        successOverlapCount: row.success_overlap_count,
      }
    : {
        imageFailedCount: 0,
        videoFailedCount: 0,
        successOverlapCount: 0,
      };
}

/** 用同一个 transaction execute 构造全部读取方法，防止查询逃逸到全局连接。 */
function createSnapshotReader(
  execute: ExecuteSql
): DataDashboardSnapshotReader {
  return {
    readSnapshotHeader: () => readSnapshotHeader(execute),
    readSuccessBuckets: (input) => readSuccessBuckets(execute, input),
    readCreditBuckets: (input) => readCreditBuckets(execute, input),
    readModelUsage: (input) => readModelUsage(execute, input),
    readFailedTasks: (input) => readFailedTasks(execute, input),
  };
}

/**
 * 从支持 PostgreSQL 事务配置的数据库端口创建生产查询仓储。
 *
 * @param database Drizzle 数据库或集成测试等价端口。
 * @returns 每次调用都建立 read-only repeatable-read 事务的快照仓储。
 */
export function createDataDashboardSnapshotRepository(
  database: DataDashboardTransactionDatabase
): DataDashboardSnapshotRepository {
  return {
    withReadOnlySnapshot<T>(
      work: (reader: DataDashboardSnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work(createSnapshotReader((query) => transaction.execute(query))),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
  };
}

/**
 * 生产仓储：动态取得数据库单例并建立唯一只读 repeatable-read 事务。
 *
 * 动态导入让 apps/web 的 DB-free Vitest 可只注入端口而不要求 DATABASE_URL。
 */
const databaseDataDashboardSnapshotRepository: DataDashboardSnapshotRepository =
  {
    async withReadOnlySnapshot<T>(
      work: (reader: DataDashboardSnapshotReader) => Promise<T>
    ): Promise<T> {
      const { db } = await import("@repo/database");
      // node-postgres 与 Neon 的联合数据库类型无法把泛型 transaction 方法赋给同一
      // 结构类型；运行时两者都实现 Drizzle 的相同 PostgreSQL 事务配置契约。
      const repository = createDataDashboardSnapshotRepository(
        db as unknown as DataDashboardTransactionDatabase
      );
      return repository.withReadOnlySnapshot(work);
    },
  };

/** 校验非负安全整数，避免测试端口或未来仓储把损坏值送入派生逻辑。 */
function requireNonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DataDashboardServiceError(
      "invalid_data",
      `${field}必须是非负安全整数`
    );
  }
  return value;
}

/** 校验有限非负积分小数；积分允许两位小数而不能套用整数 schema。 */
function requireNonnegativeCredits(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new DataDashboardServiceError(
      "invalid_data",
      `${field}必须是非负有限数字`
    );
  }
  return value;
}

/** 确认两个读模型在同一首条查询中均达到线上版本。 */
function assertDashboardReadModelsReady(
  header: DataDashboardSnapshotHeader
): void {
  if (
    header.outputUsage?.version !== 1 ||
    header.outputUsage.status !== "ready" ||
    header.creditUsage?.version !== 1 ||
    header.creditUsage.status !== "ready"
  ) {
    throw new DataDashboardServiceError("not_ready", "数据看板统计仍在准备中");
  }
  if (Number.isNaN(header.asOf.getTime())) {
    throw new DataDashboardServiceError("invalid_data", "数据看板快照时间无效");
  }
}

/** 将稀疏成功行建立为日期唯一映射，并拒绝范围外或重复桶。 */
function indexSuccessBuckets(
  rows: readonly DataDashboardSuccessBucketRow[],
  allowedDates: ReadonlySet<string>
): Map<string, DataDashboardSuccessBucketRow> {
  const byDate = new Map<string, DataDashboardSuccessBucketRow>();
  for (const row of rows) {
    if (!allowedDates.has(row.date) || byDate.has(row.date)) {
      throw new DataDashboardServiceError(
        "invalid_data",
        "成功产物查询返回重复或范围外日桶"
      );
    }
    const normalized = {
      date: row.date,
      imageCount: requireNonnegativeInteger(row.imageCount, "图片产物数"),
      imageTaskCount: requireNonnegativeInteger(
        row.imageTaskCount,
        "图片任务数"
      ),
      videoCount: requireNonnegativeInteger(row.videoCount, "视频任务数"),
      videoSeconds: requireNonnegativeInteger(row.videoSeconds, "视频秒数"),
    };
    if (normalized.imageTaskCount > normalized.imageCount) {
      throw new DataDashboardServiceError(
        "invalid_data",
        "图片任务数不能超过图片产物数"
      );
    }
    byDate.set(row.date, normalized);
  }
  return byDate;
}

/** 将稀疏积分行建立为日期唯一映射，并拒绝计费业务时间漂移。 */
function indexCreditBuckets(
  rows: readonly DataDashboardCreditBucketRow[],
  allowedDates: ReadonlySet<string>
): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const row of rows) {
    if (!allowedDates.has(row.date) || byDate.has(row.date)) {
      throw new DataDashboardServiceError(
        "invalid_data",
        "积分查询返回重复或范围外日桶"
      );
    }
    const mismatchCount = requireNonnegativeInteger(
      row.operationCreatedAtMismatchCount,
      "计费时间漂移数"
    );
    if (mismatchCount !== 0) {
      throw new DataDashboardServiceError(
        "invalid_data",
        "成功产物与计费 operation 的业务创建时间不一致"
      );
    }
    byDate.set(
      row.date,
      requireNonnegativeCredits(row.creditsConsumed, "日积分净消耗")
    );
  }
  return byDate;
}

/** 合并重复模型行并按任务数降序、规范模型 ID 升序稳定排序。 */
function normalizeModelUsage(
  rows: readonly DataDashboardModelUsageRow[],
  succeededTasks: number
): { model: string; taskCount: number } | null {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const model = row.model.trim() || "unknown";
    const taskCount = requireNonnegativeInteger(row.taskCount, "模型任务数");
    const next = requireNonnegativeInteger(
      (totals.get(model) ?? 0) + taskCount,
      "模型任务数合计"
    );
    totals.set(model, next);
  }
  const models = [...totals.entries()]
    .map(([model, taskCount]) => ({ model, taskCount }))
    .filter((item) => item.taskCount > 0)
    // 不使用 localeCompare，避免不同 Node ICU locale 改变并列模型的选择结果。
    .sort(
      (left, right) =>
        right.taskCount - left.taskCount ||
        (left.model < right.model ? -1 : left.model > right.model ? 1 : 0)
    );
  const modelTaskTotal = requireNonnegativeInteger(
    models.reduce((sum, item) => sum + item.taskCount, 0),
    "模型任务数合计"
  );
  if (modelTaskTotal !== succeededTasks) {
    throw new DataDashboardServiceError(
      "invalid_data",
      "模型任务数必须等于成功任务数"
    );
  }
  return models[0] ?? null;
}

/** 将 shared 连续自然日骨架与两类稀疏查询合并为五字段日桶。 */
function buildDashboardBuckets(
  range: ResolvedDataDashboardRange,
  successRows: readonly DataDashboardSuccessBucketRow[],
  creditRows: readonly DataDashboardCreditBucketRow[]
): DataDashboardBucket[] {
  const allowedDates = new Set(range.buckets.map((bucket) => bucket.date));
  const successByDate = indexSuccessBuckets(successRows, allowedDates);
  const creditsByDate = indexCreditBuckets(creditRows, allowedDates);
  if (
    successByDate.size !== creditsByDate.size ||
    [...successByDate.keys()].some((date) => !creditsByDate.has(date))
  ) {
    // 两条 SQL 都由同一成功事件集合驱动；日期集合不同只能来自损坏或快照逃逸。
    throw new DataDashboardServiceError(
      "invalid_data",
      "成功产物与积分聚合的日桶集合不一致"
    );
  }
  return range.buckets.map((bucket) => {
    const success = successByDate.get(bucket.date);
    return {
      date: bucket.date,
      start: bucket.start.toISOString(),
      end: bucket.end.toISOString(),
      imageCount: success?.imageCount ?? 0,
      imageTaskCount: success?.imageTaskCount ?? 0,
      videoCount: success?.videoCount ?? 0,
      videoSeconds: success?.videoSeconds ?? 0,
      creditsConsumed: creditsByDate.get(bucket.date) ?? 0,
    };
  });
}

/** 以安全整数加法汇总任务或业务量，防止超过 Number 安全范围。 */
function sumIntegerField(
  buckets: readonly DataDashboardBucket[],
  field: "imageCount" | "imageTaskCount" | "videoCount" | "videoSeconds"
): number {
  return requireNonnegativeInteger(
    buckets.reduce((sum, bucket) => sum + bucket[field], 0),
    `${field}合计`
  );
}

/** 汇总有限非负积分；最终 DTO schema 再校验跨桶精度和总计。 */
function sumCredits(buckets: readonly DataDashboardBucket[]): number {
  return requireNonnegativeCredits(
    buckets.reduce((sum, bucket) => sum + bucket.creditsConsumed, 0),
    "积分净消耗合计"
  );
}

/**
 * 在一个数据库快照中加载完整本人数据看板。
 *
 * @param input Principal 用户、账号有效时区与尚未信任的日期输入。
 * @param repository 可注入快照仓储；生产默认建立只读 repeatable-read 事务。
 * @returns 同一 asOf、范围、六项指标、连续日桶和成功任务构成。
 * @throws DataDashboardServiceError 非法范围、未 ready 或读模型损坏时整体失败。
 */
export async function loadDataDashboardSnapshot(
  input: LoadDataDashboardSnapshotInput,
  repository: DataDashboardSnapshotRepository = databaseDataDashboardSnapshotRepository
): Promise<DataDashboardOutput> {
  return repository.withReadOnlySnapshot(async (reader) => {
    try {
      const header = await reader.readSnapshotHeader();
      assertDashboardReadModelsReady(header);

      let range: ResolvedDataDashboardRange;
      try {
        range = resolveDataDashboardRange(input.rangeInput, {
          timeZone: input.timeZone,
          asOf: header.asOf,
        });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new DataDashboardServiceError(
            "validation_error",
            error.message
          );
        }
        throw error;
      }

      const query: DataDashboardRangeQuery = {
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        start: range.start,
        end: range.end,
        timeZone: range.timeZone,
      };
      const successRows = await reader.readSuccessBuckets(query);
      const creditRows = await reader.readCreditBuckets(query);
      const modelRows = await reader.readModelUsage(query);
      const failedTasks = await reader.readFailedTasks(query);

      const buckets = buildDashboardBuckets(range, successRows, creditRows);
      const imageCount = sumIntegerField(buckets, "imageCount");
      const imageTaskCount = sumIntegerField(buckets, "imageTaskCount");
      const videoCount = sumIntegerField(buckets, "videoCount");
      const videoSeconds = sumIntegerField(buckets, "videoSeconds");
      const succeeded = requireNonnegativeInteger(
        imageTaskCount + videoCount,
        "成功任务数"
      );
      const imageFailedCount = requireNonnegativeInteger(
        failedTasks.imageFailedCount,
        "失败图片任务数"
      );
      const videoFailedCount = requireNonnegativeInteger(
        failedTasks.videoFailedCount,
        "失败视频任务数"
      );
      if (
        requireNonnegativeInteger(
          failedTasks.successOverlapCount,
          "成功失败重叠任务数"
        ) !== 0
      ) {
        throw new DataDashboardServiceError(
          "invalid_data",
          "同一媒体任务不能同时为成功产物和失败状态"
        );
      }
      const failed = requireNonnegativeInteger(
        imageFailedCount + videoFailedCount,
        "失败任务数"
      );
      const terminal = requireNonnegativeInteger(
        succeeded + failed,
        "终态任务数"
      );
      const output = {
        asOf: range.asOf.toISOString(),
        timeZone: range.timeZone,
        today: range.today,
        range: {
          startDate: range.startDate,
          endDate: range.endDate,
          start: range.start.toISOString(),
          end: range.end.toISOString(),
        },
        metrics: {
          imageCount,
          videoSeconds,
          creditsConsumed: sumCredits(buckets),
          successRate: {
            succeeded,
            failed,
            terminal,
            rate: terminal === 0 ? null : succeeded / terminal,
          },
          activeDays: buckets.filter(
            (bucket) => bucket.imageTaskCount > 0 || bucket.videoCount > 0
          ).length,
          mostUsedModel: normalizeModelUsage(modelRows, succeeded),
        },
        buckets,
        taskComposition: {
          imageTaskCount,
          videoCount,
          totalTasks: succeeded,
        },
      };
      return dataDashboardOutputSchema.parse(output);
    } catch (error) {
      if (error instanceof DataDashboardServiceError) throw error;
      if (error instanceof z.ZodError) {
        throw new DataDashboardServiceError(
          "invalid_data",
          "数据看板读模型未通过输出校验"
        );
      }
      throw error;
    }
  });
}
