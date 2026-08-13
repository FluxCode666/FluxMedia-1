/**
 * 管理端全局生成历史 PostgreSQL 仓储。
 *
 * 使用方：admin-history-service 的管理员 UOL binding。图片和视频分别在索引分支内应用
 * 日期、邮箱、模型、状态、snapshot、cursor 与 limit+1，再 UNION ALL。供应商账号
 * 优先读取任务快照，旧记录才回退受控 JOIN；个人历史仓储绝不复用此全局数据作用域。
 */

import { db } from "@repo/database";
import { generation, videoGeneration } from "@repo/database/schema";
import {
  adminHistoryUserEmailSchema,
  historyRecordStatusSchema,
  historyRecordTypeSchema,
} from "@repo/shared/image-generation/history-contract";
import { videoInputManifestSchema } from "@repo/shared/image-generation/media-contract";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { extractExecuteRows } from "@/server/database-result";
import type {
  AdminHistoryCountQuery,
  AdminHistoryListQuery,
  AdminHistoryRepository,
  AdminHistorySnapshotReader,
} from "./admin-history-service";
import {
  extractGenerationCreditDetails,
  type GenerationCreditDetails,
} from "./credit-calculation-details";
import {
  extractGenerationReferenceImages,
  extractPromptRepairNotice,
} from "./generation-metadata";
import { buildVideoInputSummary } from "./video-input-lifecycle";

const adminHistoryListRowSchema = z.object({
  record_kind: historyRecordTypeSchema,
  id: z.string().min(1).max(512),
  backend_account_id: z.string().min(1).max(512).nullable(),
  backend_account_name: z.string().nullable(),
  user_id: z.string().min(1).max(512),
  user_email: adminHistoryUserEmailSchema,
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

const userOptionRowSchema = z.object({
  id: z.string().min(1).max(512),
  email: adminHistoryUserEmailSchema,
});

const requestSnapshotRowSchema = z.object({
  request_snapshot: z.unknown().nullable(),
});

const countRowSchema = z.object({
  total_count: z.coerce.number().int().nonnegative().safe(),
});

/** 返回 SQL 字面量；避免可选分支使用 OR 参数阻断索引前缀。 */
function booleanSql(value: boolean): SQL {
  return value ? sql`true` : sql`false`;
}

/** 创建全局日期半开区间、快照上限谓词。 */
function buildDatePredicate(
  input: AdminHistoryCountQuery,
  createdAt: SQL
): SQL {
  return sql`${input.start ? sql`${createdAt} >= ${input.start}` : sql`true`}
    and ${input.end ? sql`${createdAt} < ${input.end}` : sql`true`}
    and ${createdAt} <= ${input.asOf}`;
}

/** 将统一状态筛选转换为图片原始状态。 */
function buildImageStatusPredicate(
  status: AdminHistoryListQuery["status"],
  column: SQL
): SQL {
  if (status === null) return sql`true`;
  if (status === "processing") return sql`${column} = 'pending'`;
  return sql`${column} = ${status}`;
}

/** 将统一状态筛选转换为视频原始状态，processing 同时覆盖 pending/running。 */
function buildVideoStatusPredicate(
  status: AdminHistoryListQuery["status"],
  column: SQL
): SQL {
  if (status === null) return sql`true`;
  if (status === "processing") {
    return sql`${column} in ('pending', 'running')`;
  }
  return sql`${column} = ${status}`;
}

/** 创建精确模型匹配谓词。 */
function buildModelPredicate(model: string | null, column: SQL): SQL {
  return model === null ? sql`true` : sql`${column} = ${model}`;
}

/** 创建精确邮箱筛选谓词；邮箱值始终由 Zod 校验且由 Drizzle 参数化。 */
function buildUserEmailPredicate(email: string | null, column: SQL): SQL {
  return email === null ? sql`true` : sql`${column} = ${email}`;
}

/** 将全局 `(created_at desc, kind_rank desc, id desc)` cursor 下推到固定 rank 分支。 */
function buildCursorPredicate(
  input: AdminHistoryListQuery,
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
 * 构造管理端图片/视频全局 keyset 查询。
 *
 * WHY：两分支各自 limit+1 后再 UNION ALL，避免全表物化排序；邮箱筛选经 user.email
 * 唯一约束收敛为单用户索引路径，未筛选时则使用全局 created_at keyset 索引。
 */
export function buildAdminHistoryListSql(input: AdminHistoryListQuery): SQL {
  const orderDirection =
    input.cursor?.direction === "previous" ? sql`asc` : sql`desc`;
  const imageStatus = sql`case
    when g.status = 'pending' then 'processing'
    when g.status = 'completed' then 'completed'
    when g.status = 'failed' then 'failed'
    else g.status::text
  end`;
  const videoStatus = sql`case
    when v.status in ('pending', 'running') then 'processing'
    when v.status = 'completed' then 'completed'
    when v.status = 'failed' then 'failed'
    else v.status::text
  end`;
  const imageBackendAccountId = sql`coalesce(
    nullif(btrim(g.api_adapter_member_id), ''),
    nullif(btrim((g.metadata::jsonb)->'backend'->>'id'), '')
  )`;
  const videoBackendAccountId = sql`coalesce(
    nullif(btrim(v.backend_member_id), ''),
    nullif(btrim(v.api_adapter_member_id), ''),
    nullif(btrim((v.metadata::jsonb)->'backend'->>'id'), '')
  )`;
  const imageBackendAccountName = sql`nullif(
    btrim((g.metadata::jsonb)->'backend'->>'name'),
    ''
  )`;
  const videoBackendAccountName = sql`nullif(
    btrim((v.metadata::jsonb)->'backend'->>'name'),
    ''
  )`;
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
  return sql`
    with image_rows as (
      select
        'image'::text as record_kind,
        g.id::text as id,
        ${imageBackendAccountId}::text as backend_account_id,
        coalesce(
          ${imageBackendAccountName},
          backend_account.name
        )::text as backend_account_name,
        u.id::text as user_id,
        u.email::text as user_email,
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
      inner join "user" u on u.id = g.user_id
      left join image_backend_member backend_account
        on backend_account.id = ${imageBackendAccountId}
      where ${booleanSql(input.type === null || input.type === "image")}
        and ${buildDatePredicate(input, sql`g.created_at`)}
        and ${buildUserEmailPredicate(input.userEmail, sql`u.email`)}
        and ${buildModelPredicate(input.model, sql`g.model`)}
        and ${buildImageStatusPredicate(input.status, sql`g.status`)}
        and ${buildCursorPredicate(input, sql`g.created_at`, sql`g.id`, 1)}
      order by g.created_at ${orderDirection}, g.id ${orderDirection}
      limit ${input.branchLimit}
    ), video_rows as (
      select
        'video'::text as record_kind,
        v.id::text as id,
        ${videoBackendAccountId}::text as backend_account_id,
        coalesce(
          ${videoBackendAccountName},
          backend_account.name
        )::text as backend_account_name,
        u.id::text as user_id,
        u.email::text as user_email,
        v.prompt::text as prompt,
        v.model::text as model,
        ${videoStatus}::text as status,
        v.credits_consumed::numeric as credits_consumed,
        v.error::text as error,
        v.created_at,
        v.completed_at,
        null::jsonb as metadata,
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
      inner join "user" u on u.id = v.user_id
      left join image_backend_member backend_account
        on backend_account.id = ${videoBackendAccountId}
      where ${booleanSql(input.type === null || input.type === "video")}
        and ${buildDatePredicate(input, sql`v.created_at`)}
        and ${buildUserEmailPredicate(input.userEmail, sql`u.email`)}
        and ${buildModelPredicate(input.model, sql`v.model`)}
        and ${buildVideoStatusPredicate(input.status, sql`v.status`)}
        and ${buildCursorPredicate(input, sql`v.created_at`, sql`v.id`, 0)}
      order by v.created_at ${orderDirection}, v.id ${orderDirection}
      limit ${input.branchLimit}
    )
    select
      record_kind,
      id,
      backend_account_id,
      backend_account_name,
      user_id,
      user_email,
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
 * 构造管理端全局历史的精确计数查询。
 *
 * WHY：邮箱筛选继续通过唯一邮箱收敛到单用户，未筛选时按同一日期、模型、状态和
 * `asOf` 口径统计两张事实表；cursor 只决定当前页边界，不得改变授权总数。
 */
export function buildAdminHistoryCountSql(input: AdminHistoryCountQuery): SQL {
  return sql`
    select (
      select count(*)
      from generation g
      inner join "user" u on u.id = g.user_id
      where ${booleanSql(input.type === null || input.type === "image")}
        and ${buildDatePredicate(input, sql`g.created_at`)}
        and ${buildUserEmailPredicate(input.userEmail, sql`u.email`)}
        and ${buildModelPredicate(input.model, sql`g.model`)}
        and ${buildImageStatusPredicate(input.status, sql`g.status`)}
    ) + (
      select count(*)
      from video_generation v
      inner join "user" u on u.id = v.user_id
      where ${booleanSql(input.type === null || input.type === "video")}
        and ${buildDatePredicate(input, sql`v.created_at`)}
        and ${buildUserEmailPredicate(input.userEmail, sql`u.email`)}
        and ${buildModelPredicate(input.model, sql`v.model`)}
        and ${buildVideoStatusPredicate(input.status, sql`v.status`)}
    ) as total_count
  `;
}

/** 构造全局历史真实模型选项查询；邮箱筛选时仅返回该用户使用过的模型。 */
export function buildAdminHistoryModelOptionsSql(input: {
  userEmail: string | null;
  type: "image" | "video" | null;
  limit: number;
}): SQL {
  return sql`
    select model
    from (
      select g.model::text as model
      from generation g
      inner join "user" u on u.id = g.user_id
      where ${booleanSql(input.type === null || input.type === "image")}
        and ${buildUserEmailPredicate(input.userEmail, sql`u.email`)}
        and nullif(btrim(g.model), '') is not null
      union
      select v.model::text as model
      from video_generation v
      inner join "user" u on u.id = v.user_id
      where ${booleanSql(input.type === null || input.type === "video")}
        and ${buildUserEmailPredicate(input.userEmail, sql`u.email`)}
        and nullif(btrim(v.model), '') is not null
    ) history_models
    order by model asc
    limit ${input.limit}
  `;
}

/** 构造包含至少一条对应类型历史记录的用户邮箱选项查询。 */
export function buildAdminHistoryUserOptionsSql(input: {
  type: "image" | "video" | null;
  limit: number;
}): SQL {
  const hasImageHistory =
    input.type === null || input.type === "image"
      ? sql`exists (select 1 from generation g where g.user_id = u.id)`
      : sql`false`;
  const hasVideoHistory =
    input.type === null || input.type === "video"
      ? sql`exists (select 1 from video_generation v where v.user_id = u.id)`
      : sql`false`;
  return sql`
    select u.id::text as id, u.email::text as email
    from "user" u
    where (${hasImageHistory} or ${hasVideoHistory})
    order by u.email asc, u.id asc
    limit ${input.limit}
  `;
}

/** 构造单条图片或视频记录的请求快照窄查询，不读取其他 metadata 字段。 */
export function buildAdminHistoryRequestSnapshotSql(input: {
  id: string;
  kind: "image" | "video";
}): SQL {
  return input.kind === "image"
    ? sql`
        select (${generation.metadata}::jsonb)->'upstreamRequestSnapshot'
          as request_snapshot
        from ${generation}
        where ${generation.id} = ${input.id}
        limit 1
      `
    : sql`
        select (${videoGeneration.metadata}::jsonb)->'upstreamRequestSnapshot'
          as request_snapshot
        from ${videoGeneration}
        where ${videoGeneration.id} = ${input.id}
        limit 1
      `;
}

type ExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与仓储测试共用的最小 PostgreSQL 事务端口。 */
export interface AdminHistoryTransactionDatabase {
  transaction<T>(
    work: (transaction: { execute: ExecuteSql }) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ): Promise<T>;
}

/** 从唯一事务 execute 创建管理端历史快照读取器。 */
function createAdminHistorySnapshotReader(
  execute: ExecuteSql
): AdminHistorySnapshotReader {
  return {
    async countRecords(query) {
      const row = countRowSchema.parse(
        extractExecuteRows(await execute(buildAdminHistoryCountSql(query)))[0]
      );
      return row.total_count;
    },

    async readRecords(query) {
      const rows = z
        .array(adminHistoryListRowSchema)
        .parse(
          extractExecuteRows(await execute(buildAdminHistoryListSql(query)))
        );
      return rows.map((row) => {
        const backendAccount = row.backend_account_id
          ? {
              id: row.backend_account_id,
              name: row.backend_account_name?.trim().slice(0, 240) || null,
            }
          : null;
        const common = {
          backendAccount,
          id: row.id,
          userId: row.user_id,
          userEmail: row.user_email,
          prompt: row.prompt,
          model: row.model,
          status: row.status,
          creditsConsumed: row.credits_consumed,
          rawError: row.error,
          createdAt: row.created_at,
          completedAt: row.completed_at,
        };
        if (row.record_kind === "image") {
          if (!row.size)
            throw new RangeError("Admin image history size is missing");
          return {
            ...common,
            kind: "image" as const,
            revisedPrompt: row.revised_prompt,
            size: row.size,
            creditDetails: extractGenerationCreditDetails(
              row.metadata,
              row.credits_consumed
            ) as GenerationCreditDetails | null,
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
          throw new RangeError("Admin video history details are incomplete");
        }
        const inputManifest = videoInputManifestSchema.safeParse(
          row.input_manifest ?? {}
        );
        if (!inputManifest.success) {
          throw new RangeError("Admin video history input manifest is invalid");
        }
        return {
          ...common,
          kind: "video" as const,
          resolution: row.resolution,
          duration: row.duration_seconds,
          aspectRatio: row.aspect_ratio,
          generateAudio: row.generate_audio,
          input: buildVideoInputSummary(inputManifest.data),
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
          extractExecuteRows(
            await execute(buildAdminHistoryModelOptionsSql(input))
          )
        )
        .map((row) => row.model);
    },

    async readUserOptions(input) {
      return z
        .array(userOptionRowSchema)
        .parse(
          extractExecuteRows(
            await execute(buildAdminHistoryUserOptionsSql(input))
          )
        );
    },
  };
}

/** 从数据库端口创建每次列表读取都使用单一只读快照的管理端历史仓储。 */
export function createAdminHistoryRepository(
  database: AdminHistoryTransactionDatabase,
  executeOutsideSnapshot: ExecuteSql
): AdminHistoryRepository {
  return {
    withReadOnlySnapshot<T>(
      work: (reader: AdminHistorySnapshotReader) => Promise<T>
    ): Promise<T> {
      return database.transaction(
        async (transaction) =>
          work(
            createAdminHistorySnapshotReader((query) =>
              transaction.execute(query)
            )
          ),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      );
    },

    async readRequestSnapshot(input) {
      const rows = z
        .array(requestSnapshotRowSchema)
        .parse(
          extractExecuteRows(
            await executeOutsideSnapshot(
              buildAdminHistoryRequestSnapshotSql(input)
            )
          )
        );
      const row = rows[0];
      return row ? { snapshot: row.request_snapshot } : null;
    },
  };
}

/** PostgreSQL 管理端全局历史仓储实现。 */
export const databaseAdminHistoryRepository: AdminHistoryRepository =
  createAdminHistoryRepository(
    db as unknown as AdminHistoryTransactionDatabase,
    (query) => db.execute(query)
  );
