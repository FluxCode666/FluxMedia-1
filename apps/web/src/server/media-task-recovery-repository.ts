/**
 * Redis 媒体任务队列的 PostgreSQL 补偿扫描仓储。
 *
 * 职责：只读发现因 Redis 故障、进程崩溃或 BullMQ 重试耗尽而失去唤醒的图片与视频
 * 任务；不 claim、不执行业务，只返回最小版本化投递描述供低频 reconciler 补投。
 */
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  resolveVideoQueueSchedule,
  VIDEO_SUBMISSION_RECOVERY_GRACE_MS,
} from "@/features/image-generation/video-queue-schedule";
import { extractExecuteRows } from "@/server/database-result";

const identifierSchema = z.string().trim().min(1).max(128);
const scanInputSchema = z
  .object({
    now: z.date(),
    limit: z.number().int().min(1).max(1_000),
  })
  .strict();
const imageRowSchema = z.object({
  id: identifierSchema,
  attempt_count: z.coerce.number().int().nonnegative(),
});
const videoRowSchema = z.object({
  id: identifierSchema,
  stage: z.string(),
  state_version: z.coerce.number().int().nonnegative(),
  next_poll_at: z.coerce.date().nullable(),
  claim_expires_at: z.coerce.date().nullable(),
  submit_started_at: z.coerce.date().nullable(),
  updated_at: z.coerce.date(),
});

/** 一条图片补偿投递描述。 */
export interface RecoverableImageTask {
  taskId: string;
  deliveryVersion: number;
}

/** 两个物理队列的一次补偿扫描结果。 */
export interface RecoverableMediaTasks {
  images: RecoverableImageTask[];
  videos: Array<{
    taskId: string;
    stateVersion: number;
    runAt: Date;
  }>;
}

/** 补偿仓储使用的最小参数化 SQL 端口。 */
export interface MediaTaskRecoveryDatabase {
  execute(query: SQL): Promise<unknown>;
}

/** 低频恢复任务使用的只读仓储端口。 */
export interface MediaTaskRecoveryRepository {
  scan(input: z.input<typeof scanInputSchema>): Promise<RecoverableMediaTasks>;
}

/**
 * 创建 PostgreSQL 媒体任务补偿仓储。
 *
 * @param database 可注入 SQL 执行端口。
 * @returns 同时扫描图片 queued/过期 claim 与视频到期阶段的仓储。
 */
export function createPostgresMediaTaskRecoveryRepository(
  database: MediaTaskRecoveryDatabase
): MediaTaskRecoveryRepository {
  return {
    async scan(rawInput) {
      const input = scanInputSchema.parse(rawInput);
      const submissionRecoveryCutoff = new Date(
        input.now.getTime() - VIDEO_SUBMISSION_RECOVERY_GRACE_MS
      );
      const [imageResult, videoResult] = await Promise.all([
        database.execute(sql`
          select id, attempt_count
          from image_async_task
          where status = 'queued'
             or (
               status = 'running'
               and (claim_expires_at is null or claim_expires_at <= ${input.now})
             )
          order by created_at, id
          limit ${input.limit}
        `),
        database.execute(sql`
          select
            id,
            stage,
            state_version,
            next_poll_at,
            claim_expires_at,
            submit_started_at,
            updated_at
          from video_generation
          where stage not in ('completed', 'failed', 'submit_uncertain')
            and (
              claim_expires_at is null
              or claim_expires_at <= ${input.now}
            )
            and (
              (
                stage in ('created', 'polling', 'downloading', 'refunding')
                and (next_poll_at is null or next_poll_at <= ${input.now})
              )
              or (
                stage = 'charged'
                and updated_at <= ${submissionRecoveryCutoff}
              )
              or (
                stage = 'submitting'
                and coalesce(submit_started_at, updated_at) <= ${submissionRecoveryCutoff}
              )
            )
          order by coalesce(next_poll_at, updated_at), created_at, id
          limit ${input.limit}
        `),
      ]);
      const images = extractExecuteRows(imageResult).map((row) => {
        const parsed = imageRowSchema.parse(row);
        return {
          taskId: parsed.id,
          deliveryVersion: parsed.attempt_count,
        };
      });
      const videos = extractExecuteRows(videoResult).flatMap((row) => {
        const parsed = videoRowSchema.parse(row);
        const schedule = resolveVideoQueueSchedule(
          {
            id: parsed.id,
            stage: parsed.stage,
            stateVersion: parsed.state_version,
            nextPollAt: parsed.next_poll_at,
            claimExpiresAt: parsed.claim_expires_at,
            submitStartedAt: parsed.submit_started_at,
            updatedAt: parsed.updated_at,
          },
          input.now
        );
        return schedule ? [schedule] : [];
      });
      return { images, videos };
    },
  };
}

/** 默认生产补偿仓储；数据库失败显式上抛并由调度器记录。 */
export const defaultMediaTaskRecoveryRepository =
  createPostgresMediaTaskRecoveryRepository({
    async execute(query) {
      const { db } = await import("@repo/database");
      return db.execute(query);
    },
  });
