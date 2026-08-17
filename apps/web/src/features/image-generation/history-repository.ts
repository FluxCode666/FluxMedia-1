/**
 * 统一生成历史 PostgreSQL 仓储。
 *
 * 使用方：history UOL binding。图片和视频各自在命中索引的分支内应用本人、日期、
 * 筛选、snapshot、cursor 与 limit+1，再 UNION ALL；所有外部值均通过 Drizzle 参数绑定。
 */

import { db } from "@repo/database";
import {
  historyRecordStatusSchema,
  historyRecordTypeSchema,
} from "@repo/shared/image-generation/history-contract";
import { videoInputManifestSchema } from "@repo/shared/image-generation/media-contract";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { extractExecuteRows } from "@/server/database-result";
import { extractGenerationCreditDetails } from "./credit-calculation-details";
import {
  extractGenerationReferenceImages,
  extractPromptRepairNotice,
} from "./generation-metadata";
import type {
  HistoryCountQuery,
  HistoryListQuery,
  HistoryRepository,
  HistorySnapshotReader,
} from "./history-service";
import { projectVideoTaskPublicBilling } from "./video-billing-lifecycle";
import { buildVideoInputSummary } from "./video-input-lifecycle";
import {
  buildVideoPublicStatusPredicate,
  buildVideoPublicStatusSql,
  videoPublicStatusSchema,
} from "./video-public-status";

const historyListRowSchema = z.object({
  record_kind: historyRecordTypeSchema,
  id: z.string().min(1).max(512),
  prompt: z.string(),
  model: z.string().min(1).max(240),
  status: historyRecordStatusSchema,
  credits_consumed: z.coerce.number().finite().nonnegative(),
  error: z.string().nullable(),
  created_at: z.coerce.date(),
  completed_at: z.coerce.date().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  revised_prompt: z.string().nullable(),
  size: z.string().min(1).max(200).nullable(),
  storage_key: z.string().nullable(),
  storage_bucket: z.string().nullable(),
  resolution: z.string().min(1).max(100).nullable(),
  duration_seconds: z.coerce.number().int().positive().nullable(),
  aspect_ratio: z.string().min(1).max(100).nullable(),
  generate_audio: z.boolean().nullable(),
  input_manifest: z.unknown().nullable(),
});

const modelOptionRowSchema = z.object({
  model: z.string().trim().min(1).max(240),
});

const countRowSchema = z.object({
  total_count: z.coerce.number().int().nonnegative().safe(),
});

/** 返回 SQL 字面量；避免可选分支使用 OR 参数阻断索引前缀。 */
function booleanSql(value: boolean): SQL {
  return value ? sql`true` : sql`false`;
}

/** 创建可选的用户本地日期半开区间谓词。 */
function buildDatePredicate(input: HistoryCountQuery, createdAt: SQL): SQL {
  return sql`${input.start ? sql`${createdAt} >= ${input.start}` : sql`true`}
    and ${input.end ? sql`${createdAt} < ${input.end}` : sql`true`}
    and ${createdAt} <= ${input.asOf}`;
}

/** 将统一状态筛选转换为图片原始状态。 */
function buildImageStatusPredicate(
  status: HistoryListQuery["status"],
  column: SQL
): SQL {
  if (status === null) return sql`true`;
  if (status === "processing") return sql`${column} = 'pending'`;
  return sql`${column} = ${status}`;
}

/** 将统一状态筛选转换为视频原始 status/stage 谓词。 */
function buildVideoStatusPredicate(
  status: HistoryListQuery["status"],
  statusColumn: SQL,
  stageColumn: SQL,
  capacityWaitDeadlineColumn: SQL
): SQL {
  if (status === null) return sql`true`;
  if (status === "processing") return sql`false`;
  return buildVideoPublicStatusPredicate(
    videoPublicStatusSchema.parse(status),
    statusColumn,
    stageColumn,
    capacityWaitDeadlineColumn
  );
}

/** 创建模型精确匹配谓词；搜索行为只属于前端模型选项，不进入 SQL 模糊匹配。 */
function buildModelPredicate(model: string | null, column: SQL): SQL {
  return model === null ? sql`true` : sql`${column} = ${model}`;
}

/**
 * 将全局 `(created_at desc, kind_rank desc, id desc)` cursor 下推到固定 rank 分支。
 */
function buildCursorPredicate(
  input: HistoryListQuery,
  createdAt: SQL,
  id: SQL,
  kindRank: number
): SQL {
  if (!input.cursor) return sql`true`;
  const isPrevious = input.cursor.direction === "previous";
  const sameTimestampPredicate =
    kindRank === input.cursor.kindRank
      ? isPrevious
        ? sql`${id} > ${input.cursor.id}`
        : sql`${id} < ${input.cursor.id}`
      : isPrevious
        ? booleanSql(kindRank > input.cursor.kindRank)
        : booleanSql(kindRank < input.cursor.kindRank);
  return isPrevious
    ? sql`(${createdAt} > ${input.cursor.createdAt}
      or (${createdAt} = ${input.cursor.createdAt} and ${sameTimestampPredicate}))`
    : sql`(${createdAt} < ${input.cursor.createdAt}
    or (${createdAt} = ${input.cursor.createdAt} and ${sameTimestampPredicate}))`;
}

/**
 * 构造图片/视频两分支有界 keyset 查询。
 *
 * WHY：分支内先 limit+1 可约束单用户大历史的排序与内存；最终 UNION 只合并至多
 * `2 * branchLimit` 行，同时稳定 rank 保证同毫秒跨表记录不重复、不遗漏。
 */
export function buildHistoryListSql(input: HistoryListQuery): SQL {
  const orderDirection =
    input.cursor?.direction === "previous" ? sql`asc` : sql`desc`;
  const imageStatus = sql`case
    when g.status = 'pending' then 'processing'
    when g.status = 'completed' then 'completed'
    when g.status = 'failed' then 'failed'
    else g.status::text
  end`;
  const videoStatus = buildVideoPublicStatusSql(
    sql`v.status`,
    sql`v.stage`,
    sql`v.capacity_wait_deadline_at`
  );
  const imageHistoryMetadata = sql`case
    when g.metadata is null then null
    else jsonb_build_object(
      'billingGroupId', (g.metadata::jsonb)->'billingGroupId',
      'mode', (g.metadata::jsonb)->'mode',
      'backend', jsonb_build_object(
        'billingGroupId', (g.metadata::jsonb)->'backend'->'billingGroupId'
      ),
      'creditCost', (g.metadata::jsonb)->'creditCost',
      'chatTextOnlyCharge', (g.metadata::jsonb)->'chatTextOnlyCharge',
      'outputImage', jsonb_build_object(
        'requestedSize', (g.metadata::jsonb)->'outputImage'->'requestedSize',
        'actualSize', (g.metadata::jsonb)->'outputImage'->'actualSize',
        'requestedResolution', (g.metadata::jsonb)->'outputImage'->'requestedResolution',
        'settledResolution', (g.metadata::jsonb)->'outputImage'->'settledResolution',
        'requestedCreditCost', (g.metadata::jsonb)->'outputImage'->'requestedCreditCost',
        'actualCreditCost', (g.metadata::jsonb)->'outputImage'->'actualCreditCost',
        'perOutputCreditCosts', (g.metadata::jsonb)->'outputImage'->'perOutputCreditCosts',
        'chatRoundCredits', (g.metadata::jsonb)->'outputImage'->'chatRoundCredits',
        'chatRoundCount', (g.metadata::jsonb)->'outputImage'->'chatRoundCount',
        'billableImageOutputCount', (g.metadata::jsonb)->'outputImage'->'billableImageOutputCount',
        'upstreamImageOutputCount', (g.metadata::jsonb)->'outputImage'->'upstreamImageOutputCount',
        'layered', (g.metadata::jsonb)->'outputImage'->'layered'
      ),
      'moderationPromptRepair', (g.metadata::jsonb)->'moderationPromptRepair',
      'inputImages', (g.metadata::jsonb)->'inputImages'
    )
  end`;
  const videoHistoryMetadata = sql`case
    when v.metadata is null then null
    else jsonb_strip_nulls(jsonb_build_object(
      'videoCapabilitySnapshot',
      (v.metadata::jsonb)->'videoCapabilitySnapshot',
      'videoBillingSnapshot',
      (v.metadata::jsonb)->'videoBillingSnapshot'
    ))
  end`;
  return sql`
    with image_rows as (
      select
        'image'::text as record_kind,
        g.id::text as id,
        g.prompt::text as prompt,
        g.model::text as model,
        ${imageStatus}::text as status,
        g.credits_consumed::numeric as credits_consumed,
        g.error::text as error,
        g.created_at,
        g.completed_at,
        ${imageHistoryMetadata} as metadata,
        g.revised_prompt::text as revised_prompt,
        g.size::text as size,
        g.storage_key::text as storage_key,
        g.storage_bucket::text as storage_bucket,
        null::text as resolution,
        null::integer as duration_seconds,
        null::text as aspect_ratio,
        null::boolean as generate_audio,
        null::jsonb as input_manifest,
        1::integer as kind_rank
      from generation g
      where g.user_id = ${input.userId}
        and ${booleanSql(input.type === null || input.type === "image")}
        and ${buildDatePredicate(input, sql`g.created_at`)}
        and ${buildModelPredicate(input.model, sql`g.model`)}
        and ${buildImageStatusPredicate(input.status, sql`g.status`)}
        and ${buildCursorPredicate(input, sql`g.created_at`, sql`g.id`, 1)}
      order by g.created_at ${orderDirection}, g.id ${orderDirection}
      limit ${input.branchLimit}
    ), video_rows as (
      select
        'video'::text as record_kind,
        v.id::text as id,
        v.prompt::text as prompt,
        v.model::text as model,
        ${videoStatus}::text as status,
        v.credits_consumed::numeric as credits_consumed,
        v.error::text as error,
        v.created_at,
        v.completed_at,
        ${videoHistoryMetadata} as metadata,
        null::text as revised_prompt,
        null::text as size,
        v.storage_key::text as storage_key,
        v.storage_bucket::text as storage_bucket,
        v.resolution::text as resolution,
        v.duration_seconds::integer as duration_seconds,
        v.aspect_ratio::text as aspect_ratio,
        case
          when jsonb_typeof((v.metadata::jsonb)->'generateAudio') = 'boolean'
          then ((v.metadata::jsonb)->>'generateAudio')::boolean
          else null
        end as generate_audio,
        v.input_manifest::jsonb as input_manifest,
        0::integer as kind_rank
      from video_generation v
      where v.user_id = ${input.userId}
        and ${booleanSql(input.type === null || input.type === "video")}
        and ${buildDatePredicate(input, sql`v.created_at`)}
        and ${buildModelPredicate(input.model, sql`v.model`)}
        and ${buildVideoStatusPredicate(
          input.status,
          sql`v.status`,
          sql`v.stage`,
          sql`v.capacity_wait_deadline_at`
        )}
        and ${buildCursorPredicate(input, sql`v.created_at`, sql`v.id`, 0)}
      order by v.created_at ${orderDirection}, v.id ${orderDirection}
      limit ${input.branchLimit}
    )
    select
      record_kind,
      id,
      prompt,
      model,
      status,
      credits_consumed,
      error,
      created_at,
      completed_at,
      metadata,
      revised_prompt,
      size,
      storage_key,
      storage_bucket,
      resolution,
      duration_seconds,
      aspect_ratio,
      generate_audio,
      input_manifest
    from (
      select * from image_rows
      union all
      select * from video_rows
    ) history_rows
    order by created_at ${orderDirection}, kind_rank ${orderDirection}, id ${orderDirection}
    limit ${input.branchLimit}
  `;
}

/**
 * 构造与本人历史列表完全同口径的精确计数查询。
 *
 * WHY：图片与视频分表分别命中用户、日期和筛选索引，再合并两个标量；不把
 * cursor 谓词带入总数，确保每一页显示的是当前快照内完整授权结果数。
 */
export function buildHistoryCountSql(input: HistoryCountQuery): SQL {
  return sql`
    select media_history_exact_count(
      'owner',
      ${input.userId},
      ${input.type},
      ${input.status},
      ${input.model},
      ${input.start},
      ${input.end},
      ${input.asOf}
    ) as total_count
  `;
}

/** 构造本人历史真实模型选项查询；UNION 去重且输出严格有界。 */
export function buildHistoryModelOptionsSql(input: {
  userId: string;
  type: "image" | "video" | null;
  limit: number;
}): SQL {
  return sql`
    select model
    from (
      select g.model::text as model
      from generation g
      where g.user_id = ${input.userId}
        and ${booleanSql(input.type === null || input.type === "image")}
        and nullif(btrim(g.model), '') is not null
      union
      select v.model::text as model
      from video_generation v
      where v.user_id = ${input.userId}
        and ${booleanSql(input.type === null || input.type === "video")}
        and nullif(btrim(v.model), '') is not null
    ) history_models
    order by model asc
    limit ${input.limit}
  `;
}

type ExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与仓储测试共用的最小 PostgreSQL 事务端口。 */
export interface HistoryTransactionDatabase {
  transaction<T>(
    work: (transaction: { execute: ExecuteSql }) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ): Promise<T>;
}

/** 从唯一事务 execute 创建本人历史读取器，禁止查询逃逸到全局连接。 */
function createHistorySnapshotReader(
  execute: ExecuteSql
): HistorySnapshotReader {
  return {
    async countRecords(query) {
      const row = countRowSchema.parse(
        extractExecuteRows(await execute(buildHistoryCountSql(query)))[0]
      );
      return row.total_count;
    },

    async readRecords(query) {
      const rows = z
        .array(historyListRowSchema)
        .parse(extractExecuteRows(await execute(buildHistoryListSql(query))));
      return rows.map((row) => {
        const common = {
          id: row.id,
          prompt: row.prompt,
          model: row.model,
          status: row.status,
          creditsConsumed: row.credits_consumed,
          rawError: row.error,
          createdAt: row.created_at,
          completedAt: row.completed_at,
        };
        if (row.record_kind === "image") {
          if (!row.size) throw new RangeError("Image history size is missing");
          return {
            ...common,
            kind: "image" as const,
            revisedPrompt: row.revised_prompt,
            size: row.size,
            creditDetails: extractGenerationCreditDetails(
              row.metadata,
              row.credits_consumed
            ),
            promptRepairNotice: extractPromptRepairNotice(row.metadata),
            referenceImages: extractGenerationReferenceImages(row.metadata)
              .slice(0, 50)
              .map(
                ({
                  storageBucket: _storageBucket,
                  storageKey: _storageKey,
                  ...safe
                }) => safe
              ),
            imageUrl: buildSignedStorageImageUrl(
              row.storage_key,
              row.storage_bucket
            ),
          };
        }
        if (
          !row.resolution ||
          !row.duration_seconds ||
          !row.aspect_ratio ||
          row.generate_audio === null
        ) {
          throw new RangeError("Video history details are incomplete");
        }
        const inputManifest = videoInputManifestSchema.safeParse(
          row.input_manifest ?? {}
        );
        if (!inputManifest.success) {
          throw new RangeError("Video history input manifest is invalid");
        }
        return {
          ...common,
          kind: "video" as const,
          resolution: row.resolution,
          duration: row.duration_seconds,
          aspectRatio: row.aspect_ratio,
          generateAudio: row.generate_audio,
          input: buildVideoInputSummary(inputManifest.data),
          billing: projectVideoTaskPublicBilling(
            row.metadata,
            row.credits_consumed
          ),
          videoUrl: buildSignedStorageImageUrl(
            row.storage_key,
            row.storage_bucket
          ),
        };
      });
    },

    async readModelOptions(input) {
      return z
        .array(modelOptionRowSchema)
        .parse(
          extractExecuteRows(await execute(buildHistoryModelOptionsSql(input)))
        )
        .map((row) => row.model);
    },
  };
}

/** 从数据库端口创建每次读取都使用只读 repeatable-read 的本人历史仓储。 */
export function createHistoryRepository(
  database: HistoryTransactionDatabase
): HistoryRepository {
  return {
    withReadOnlySnapshot<T>(
      work: (reader: HistorySnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work(
            createHistorySnapshotReader((query) => transaction.execute(query))
          ),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },
  };
}

/** PostgreSQL 统一历史仓储实现。 */
export const databaseHistoryRepository: HistoryRepository =
  createHistoryRepository(db as unknown as HistoryTransactionDatabase);
