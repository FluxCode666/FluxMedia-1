/**
 * 视频临时输入对象的持久清理队列。
 *
 * 职责：登记对象存储删除失败、原子认领到期条目，并在多实例 worker 中完成或退避
 * 重试。使用方是视频输入存储层与视频恢复定时任务；数据库端口可注入以做 DB-free
 * SQL 契约测试。
 */
import { createHash, randomUUID } from "node:crypto";
import { MAX_MEDIA_INPUT_COUNT } from "@repo/shared/image-generation/media-contract";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

const CLEANUP_BATCH_LIMIT = 25;
const CLEANUP_CLAIM_TTL_MS = 5 * 60_000;
const CLEANUP_RETRY_BASE_MS = 60_000;
const CLEANUP_RETRY_MAX_MS = 60 * 60_000;

const cleanupObjectBaseSchema = z
  .object({
    reason: z.enum(["orphan", "lifecycle_delete"]),
    userId: z.string().trim().min(1).max(512),
    videoId: z.string().trim().min(1).max(512),
    attemptId: z.string().trim().min(1).max(128),
    storageKey: z.string().trim().min(1).max(1_024),
    storageBucket: z.string().trim().min(1).max(128),
  })
  .strict();

/** 校验对象 key 与可信用户/任务身份一致。 */
function isOwnedCleanupObject(
  object: z.infer<typeof cleanupObjectBaseSchema>
): boolean {
  const prefix = `${object.userId}/video-inputs/${object.videoId}/`;
  if (!object.storageKey.startsWith(prefix)) return false;
  const segments = object.storageKey.slice(prefix.length).split("/");
  return (
    segments.length === 2 &&
    segments.every(Boolean) &&
    segments[0] === object.attemptId
  );
}

const cleanupObjectSchema = cleanupObjectBaseSchema.refine(
  isOwnedCleanupObject,
  { message: "视频输入清理对象不属于指定用户和任务" }
);
const claimedCleanupSchema = cleanupObjectBaseSchema
  .extend({
    id: z.string().length(64),
    attemptCount: z
      .union([z.number(), z.string()])
      .transform(Number)
      .pipe(z.number().int().nonnegative()),
    claimToken: z.string().trim().min(1).max(512),
  })
  .refine(isOwnedCleanupObject, {
    message: "视频输入清理对象不属于指定用户和任务",
  });

/** 可持久登记的对象存储身份。 */
export type VideoInputCleanupObject = z.infer<typeof cleanupObjectSchema>;

/** 已由当前 worker 独占的清理条目。 */
export type ClaimedVideoInputCleanup = z.infer<typeof claimedCleanupSchema>;

/** 重新校验数据库或调用方提供的可信清理对象数组。 */
export function parseVideoInputCleanupObjects(
  value: unknown
): VideoInputCleanupObject[] {
  return cleanupObjectSchema.array().max(MAX_MEDIA_INPUT_COUNT).parse(value);
}

/** 清理队列只依赖参数化 SQL execute 端口。 */
export interface VideoInputCleanupDatabase {
  execute(query: SQL): Promise<unknown>;
}

/** 清理队列仓储接口。 */
export interface VideoInputCleanupRepository {
  enqueue(objects: VideoInputCleanupObject[]): Promise<number>;
  claimNext(input: {
    claimToken: string;
    now: Date;
    claimExpiresAt: Date;
  }): Promise<ClaimedVideoInputCleanup | null>;
  complete(input: { id: string; claimToken: string }): Promise<void>;
  retry(input: {
    claimed: ClaimedVideoInputCleanup;
    error: unknown;
    now: Date;
  }): Promise<void>;
  adoptOrphans(objects: VideoInputCleanupObject[]): Promise<void>;
}

/** 用 bucket/key 的完整身份生成稳定、定长的队列主键。 */
function createCleanupId(object: VideoInputCleanupObject): string {
  return createHash("sha256")
    .update(object.userId)
    .update("\0")
    .update(object.reason)
    .update("\0")
    .update(object.videoId)
    .update("\0")
    .update(object.attemptId)
    .update("\0")
    .update(object.storageBucket)
    .update("\0")
    .update(object.storageKey)
    .digest("hex");
}

/** 为下一次失败计算有上限的指数退避。 */
function getRetryAt(now: Date, nextAttemptCount: number): Date {
  const delay = Math.min(
    CLEANUP_RETRY_MAX_MS,
    CLEANUP_RETRY_BASE_MS * 2 ** Math.min(nextAttemptCount - 1, 10)
  );
  return new Date(now.getTime() + delay);
}

/** 创建 PostgreSQL 清理队列仓储。 */
export function createPostgresVideoInputCleanupRepository(
  database: VideoInputCleanupDatabase
): VideoInputCleanupRepository {
  return {
    async enqueue(rawObjects) {
      const objects = parseVideoInputCleanupObjects(rawObjects);
      const uniqueObjects = new Map(
        objects.map((object) => [createCleanupId(object), object])
      );
      for (const [id, object] of uniqueObjects) {
        await database.execute(sql`
          insert into video_input_cleanup (
            id,
            reason,
            user_id,
            video_id,
            attempt_id,
            storage_key,
            storage_bucket,
            next_attempt_at,
            updated_at
          )
          values (
            ${id},
            ${object.reason},
            ${object.userId},
            ${object.videoId},
            ${object.attemptId},
            ${object.storageKey},
            ${object.storageBucket},
            now(),
            now()
          )
          on conflict (id) do update
          set reason = excluded.reason,
              user_id = excluded.user_id,
              video_id = excluded.video_id,
              attempt_id = excluded.attempt_id,
              storage_key = excluded.storage_key,
              storage_bucket = excluded.storage_bucket,
              next_attempt_at = least(
                video_input_cleanup.next_attempt_at,
                excluded.next_attempt_at
              ),
              updated_at = now()
        `);
      }
      return uniqueObjects.size;
    },

    async claimNext(input) {
      const claimToken = z
        .string()
        .trim()
        .min(1)
        .max(512)
        .parse(input.claimToken);
      if (input.claimExpiresAt.getTime() <= input.now.getTime()) {
        throw new Error("视频输入清理 claim 到期时间无效");
      }
      // WHY：上传超时严格早于 reservation TTL；到期行已不可能对应活跃上传，可在
      // claim 前分批回收。候选随后要求 reservation 完全不存在，避免残留行与清理
      // worker 对同一 attempt 的对象生命周期产生歧义。
      await database.execute(sql`
        with expired as (
          select task_id
          from video_task_staging_reservation
          where expires_at <= ${input.now}
          order by expires_at, task_id
          limit 100
          for update skip locked
        )
        delete from video_task_staging_reservation as reservation
        using expired
        where reservation.task_id = expired.task_id
      `);
      const result = await database.execute(sql`
        with candidate as (
          select id
          from video_input_cleanup
          where next_attempt_at <= ${input.now}
            and (
              claim_expires_at is null
              or claim_expires_at <= ${input.now}
            )
            and pg_try_advisory_xact_lock(
              hashtextextended('video-user:' || user_id, 0)
            )
            and (
              (
                video_input_cleanup.reason = 'orphan'
                and not exists (
                  select 1
                  from video_generation as task
                  where task.id = video_input_cleanup.video_id
                    and task.user_id = video_input_cleanup.user_id
                )
              )
              or (
                video_input_cleanup.reason = 'lifecycle_delete'
                and exists (
                  select 1
                  from video_generation as task
                  join "user" as account
                    on account.id = task.user_id
                  where task.id = video_input_cleanup.video_id
                    and task.user_id = video_input_cleanup.user_id
                    and task.stage in ('completed', 'failed')
                    and account.banned = true
                    and account.banned_reason = 'account_deleted'
                )
              )
            )
            and not exists (
              select 1
              from video_task_staging_reservation as reservation
              where reservation.task_id = video_input_cleanup.video_id
                and reservation.user_id = video_input_cleanup.user_id
                and reservation.reservation_token = video_input_cleanup.attempt_id
            )
          order by next_attempt_at, created_at, id
          limit 1
          for update skip locked
        )
        update video_input_cleanup as cleanup
        set claim_token = ${claimToken},
            claim_expires_at = ${input.claimExpiresAt},
            updated_at = ${input.now}
        from candidate
        where cleanup.id = candidate.id
        returning
          cleanup.id,
          cleanup.reason,
          cleanup.user_id as "userId",
          cleanup.video_id as "videoId",
          cleanup.attempt_id as "attemptId",
          cleanup.storage_key as "storageKey",
          cleanup.storage_bucket as "storageBucket",
          cleanup.attempt_count as "attemptCount",
          cleanup.claim_token as "claimToken"
      `);
      const row = extractExecuteRows(result)[0];
      return row ? claimedCleanupSchema.parse(row) : null;
    },

    async complete(input) {
      const result = await database.execute(sql`
        delete from video_input_cleanup
        where id = ${input.id}
          and claim_token = ${input.claimToken}
        returning id
      `);
      if (extractExecuteRows(result).length !== 1) {
        throw new Error("视频输入清理完成状态写入失败");
      }
    },

    async retry(input) {
      const message = (
        input.error instanceof Error
          ? input.error.message
          : "视频输入对象删除失败"
      ).slice(0, 1_000);
      const nextAttemptCount = input.claimed.attemptCount + 1;
      const result = await database.execute(sql`
        update video_input_cleanup
        set attempt_count = ${nextAttemptCount},
            next_attempt_at = ${getRetryAt(input.now, nextAttemptCount)},
            claim_token = null,
            claim_expires_at = null,
            last_error = ${message},
            updated_at = ${input.now}
        where id = ${input.claimed.id}
          and claim_token = ${input.claimed.claimToken}
        returning id
      `);
      if (extractExecuteRows(result).length !== 1) {
        throw new Error("视频输入清理重试状态写入失败");
      }
    },

    async adoptOrphans(rawObjects) {
      const objects = parseVideoInputCleanupObjects(rawObjects);
      for (const object of objects) {
        if (object.reason !== "orphan") {
          throw new Error("视频任务只能采用 orphan 输入清理意图");
        }
        const id = createCleanupId(object);
        const result = await database.execute(sql`
          delete from video_input_cleanup
          where id = ${id}
            and reason = 'orphan'
            and user_id = ${object.userId}
            and video_id = ${object.videoId}
            and attempt_id = ${object.attemptId}
            and claim_token is null
          returning id
        `);
        if (extractExecuteRows(result).length !== 1) {
          throw new Error("视频输入清理意图缺失或已被 worker 认领");
        }
      }
    },
  };
}

/** 生产清理队列仓储；数据库故障显式上抛，避免伪装为已登记或已删除。 */
export const defaultVideoInputCleanupRepository: VideoInputCleanupRepository =
  createPostgresVideoInputCleanupRepository({
    async execute(query) {
      const { db } = await import("@repo/database");
      return db.execute(query);
    },
  });

/** 登记一组稍后重试删除的临时视频输入对象。 */
export async function enqueueVideoInputCleanup(
  objects: VideoInputCleanupObject[]
): Promise<number> {
  return defaultVideoInputCleanupRepository.enqueue(objects);
}

/**
 * 在视频任务创建事务内采用对象并完成 orphan 清理意图。
 *
 * 调用方必须已持有同一 userId 的视频准入 advisory lock；队列 claim 使用相同锁，
 * 因而“采用意图并插入任务”与“认领后删除对象”只能有一方获胜。删除 orphan 行与
 * 任务插入在同一事务提交，插入失败会恢复意图，已采用对象不再被 worker 认领。
 */
export async function adoptVideoInputObjectsForPersistence(
  executor: VideoInputCleanupDatabase,
  objects: VideoInputCleanupObject[]
): Promise<void> {
  if (objects.length === 0) return;
  const repository = createPostgresVideoInputCleanupRepository(executor);
  await repository.adoptOrphans(objects);
}

/** 认领并处理一批持久清理条目；每个条目的失败独立退避。 */
export async function runVideoInputCleanupJob(): Promise<{
  claimed: number;
  deleted: number;
  failed: number;
}> {
  let claimed = 0;
  let deleted = 0;
  let failed = 0;
  for (let index = 0; index < CLEANUP_BATCH_LIMIT; index += 1) {
    const now = new Date();
    const job = await defaultVideoInputCleanupRepository.claimNext({
      claimToken: randomUUID(),
      now,
      claimExpiresAt: new Date(now.getTime() + CLEANUP_CLAIM_TTL_MS),
    });
    if (!job) break;
    claimed += 1;
    try {
      const { getStorageRuntimeSnapshot } = await import(
        "@repo/shared/storage/providers"
      );
      const snapshot = await getStorageRuntimeSnapshot();
      if (job.storageBucket !== snapshot.bucketName) {
        throw new Error("视频输入清理对象不属于当前存储 bucket");
      }
      await snapshot.provider.deleteObject(job.storageKey, job.storageBucket);
      await defaultVideoInputCleanupRepository.complete({
        id: job.id,
        claimToken: job.claimToken,
      });
      deleted += 1;
    } catch (error) {
      failed += 1;
      await defaultVideoInputCleanupRepository.retry({
        claimed: job,
        error,
        now: new Date(),
      });
    }
  }
  return { claimed, deleted, failed };
}
