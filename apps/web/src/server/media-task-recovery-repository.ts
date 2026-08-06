/**
 * Redis 媒体任务队列的 PostgreSQL 补偿扫描仓储。
 *
 * 职责：按独立 due 游标发现图片 MQ、claim、admission、terminal release 和视频任务；
 * 不 claim、不执行业务，只返回最小恢复描述供低频 reconciler 处理。
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
const imageDeliveryRowSchema = z.object({
  id: identifierSchema,
  mq_delivery_version: z.coerce.number().int().nonnegative(),
  mq_delivery_due_at: z.coerce.date().nullable(),
  claim_recovery_due_at: z.coerce.date().nullable(),
  group_priority_snapshot: z.coerce.number().int().min(0).max(10_000),
});
const imageAdmissionRowSchema = z.object({
  id: identifierSchema,
  user_id: identifierSchema,
  effective_user_concurrency: z.coerce.number().int().min(1).max(10_000),
  admission_lease_token: z.string().trim().min(1).max(256),
  admission_lease_expires_at: z.coerce.date(),
  admission_renewal_due_at: z.coerce.date(),
});
const imageTerminalReleaseRowSchema = z.object({
  id: identifierSchema,
  user_id: identifierSchema,
  admission_lease_token: z.string().trim().min(1).max(256),
  admission_lease_expires_at: z.coerce.date(),
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
  dueAt: Date;
  priority: number;
  recoveryKind: "mq" | "claim";
}

/** 一条需要续期或重新裁决 admission 的非终态图片任务。 */
export interface RecoverableImageAdmission {
  taskId: string;
  userId: string;
  effectiveUserConcurrency: number;
  token: string;
  expiresAt: Date;
  renewalDueAt: Date;
}

/** 一条终态已提交但尚未持久确认 Redis 释放的图片任务。 */
export interface RecoverableImageTerminalRelease {
  taskId: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

/** 两个物理队列及图片租约的一次补偿扫描结果。 */
export interface RecoverableMediaTasks {
  images: RecoverableImageTask[];
  imageAdmissions: RecoverableImageAdmission[];
  imageTerminalReleases: RecoverableImageTerminalRelease[];
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
 * @returns 分别扫描图片四类 due 与视频到期阶段的仓储。
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
      const [
        imageMqResult,
        imageClaimResult,
        imageAdmissionResult,
        imageTerminalReleaseResult,
        videoResult,
      ] = await Promise.all([
        database.execute(sql`
          select
            id,
            mq_delivery_version,
            mq_delivery_due_at,
            claim_recovery_due_at,
            group_priority_snapshot
          from image_async_task
          where status in ('queued', 'running')
            and mq_delivery_due_at <= ${input.now}
          order by mq_delivery_due_at, id
          limit ${input.limit}
        `),
        database.execute(sql`
          select
            id,
            mq_delivery_version,
            mq_delivery_due_at,
            claim_recovery_due_at,
            group_priority_snapshot
          from image_async_task
          where status = 'running'
            and claim_recovery_due_at <= ${input.now}
            and mq_delivery_due_at is null
          order by claim_recovery_due_at, id
          limit ${input.limit}
        `),
        database.execute(sql`
          select
            id,
            user_id,
            effective_user_concurrency,
            admission_lease_token,
            admission_lease_expires_at,
            admission_renewal_due_at
          from image_async_task
          where status in ('queued', 'running')
            and admission_renewal_due_at <= ${input.now}
          order by admission_renewal_due_at, id
          limit ${input.limit}
        `),
        database.execute(sql`
          select
            id,
            user_id,
            admission_lease_token,
            admission_lease_expires_at
          from image_async_task
          where status in ('completed', 'failed')
            and terminal_release_due_at <= ${input.now}
            and admission_lease_released_at is null
          order by terminal_release_due_at, id
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
      /** 将 MQ 或 claim due 行映射为携带持久优先级的最小补投描述。 */
      const mapImageDelivery = (
        row: unknown,
        recoveryKind: RecoverableImageTask["recoveryKind"]
      ): RecoverableImageTask => {
        const parsed = imageDeliveryRowSchema.parse(row);
        const dueAt =
          recoveryKind === "mq"
            ? parsed.mq_delivery_due_at
            : parsed.claim_recovery_due_at;
        if (!dueAt) {
          throw new Error("图片恢复行缺少对应的 due 游标");
        }
        return {
          taskId: parsed.id,
          deliveryVersion: parsed.mq_delivery_version,
          dueAt,
          priority: parsed.group_priority_snapshot + 1,
          recoveryKind,
        };
      };
      const images = [
        ...extractExecuteRows(imageMqResult).map((row) =>
          mapImageDelivery(row, "mq")
        ),
        ...extractExecuteRows(imageClaimResult).map((row) =>
          mapImageDelivery(row, "claim")
        ),
      ];
      const imageAdmissions = extractExecuteRows(imageAdmissionResult).map(
        (row): RecoverableImageAdmission => {
          const parsed = imageAdmissionRowSchema.parse(row);
          return {
            taskId: parsed.id,
            userId: parsed.user_id,
            effectiveUserConcurrency: parsed.effective_user_concurrency,
            token: parsed.admission_lease_token,
            expiresAt: parsed.admission_lease_expires_at,
            renewalDueAt: parsed.admission_renewal_due_at,
          };
        }
      );
      const imageTerminalReleases = extractExecuteRows(
        imageTerminalReleaseResult
      ).map((row): RecoverableImageTerminalRelease => {
        const parsed = imageTerminalReleaseRowSchema.parse(row);
        return {
          taskId: parsed.id,
          userId: parsed.user_id,
          token: parsed.admission_lease_token,
          expiresAt: parsed.admission_lease_expires_at,
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
      return { images, imageAdmissions, imageTerminalReleases, videos };
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
