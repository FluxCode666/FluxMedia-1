/**
 * 视频恢复任务的 PostgreSQL 认领仓储。
 *
 * 职责：以生产 SQL 原子选择并认领一条到期任务；调用方按 worker 数即时认领，避免
 * 批量任务在本地队列等待时 claim 过期。使用方是视频恢复 worker 与真实数据库测试。
 */
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

const identifierSchema = z.string().trim().min(1).max(512);
export const VIDEO_SUBMISSION_RECOVERY_GRACE_MS = 21 * 60_000;

const claimInputSchema = z
  .object({
    claimToken: identifierSchema,
    now: z.date(),
    claimExpiresAt: z.date(),
  })
  .strict()
  .refine((input) => input.claimExpiresAt.getTime() > input.now.getTime(), {
    message: "Claim expiration must be later than claim time",
    path: ["claimExpiresAt"],
  });

const claimedVideoRowSchema = z.object({ id: identifierSchema });

/** 单条视频恢复 claim 的稳定结果。 */
export interface ClaimedVideoRecoveryJob {
  id: string;
  claimToken: string;
}

/** 视频恢复 claim 输入；时钟和 token 显式注入以便并发测试。 */
export type ClaimNextVideoRecoveryJobInput = z.input<typeof claimInputSchema>;

/** 视频恢复仓储只依赖参数化 SQL 事务端口。 */
export interface VideoRecoveryTransaction {
  execute(query: SQL): Promise<unknown>;
}

/** 生产数据库与真实 PostgreSQL 测试共用的最小事务入口。 */
export interface VideoRecoveryDatabase {
  transaction<T>(
    work: (transaction: VideoRecoveryTransaction) => Promise<T>
  ): Promise<T>;
}

/** 视频恢复 worker 使用的仓储端口。 */
export interface VideoRecoveryRepository {
  claimNext(
    input: ClaimNextVideoRecoveryJobInput
  ): Promise<ClaimedVideoRecoveryJob | null>;
}

/**
 * 创建视频恢复 PostgreSQL 仓储。
 *
 * @param database 可注入的参数化 SQL 事务入口。
 * @returns 每次只认领一条到期任务的仓储。
 */
export function createPostgresVideoRecoveryRepository(
  database: VideoRecoveryDatabase
): VideoRecoveryRepository {
  return {
    async claimNext(rawInput) {
      const input = claimInputSchema.parse(rawInput);
      return database.transaction(async (transaction) => {
        const result = await transaction.execute(sql`
          with candidate as (
            select id
            from video_generation
            where (
                (
                  stage in ('created', 'polling', 'downloading', 'refunding')
                  and (next_poll_at is null or next_poll_at <= ${input.now})
                )
                or (
                  stage = 'charged'
                  and updated_at <= ${new Date(
                    input.now.getTime() - VIDEO_SUBMISSION_RECOVERY_GRACE_MS
                  )}
                )
                or (
                  stage = 'submitting'
                  and coalesce(submit_started_at, updated_at) <= ${new Date(
                    input.now.getTime() - VIDEO_SUBMISSION_RECOVERY_GRACE_MS
                  )}
                )
              )
              and (
                claim_expires_at is null
                or claim_expires_at <= ${input.now}
              )
            order by
              case stage
                when 'refunding' then 0
                when 'downloading' then 1
                when 'polling' then 2
                when 'submitting' then 3
                when 'charged' then 3
                else 4
              end,
              coalesce(
                next_poll_at,
                submit_started_at,
                updated_at,
                created_at
              ),
              created_at,
              id
            limit 1
            for update skip locked
          )
          update video_generation as task
          set claim_token = ${input.claimToken},
              claim_expires_at = ${input.claimExpiresAt},
              state_version = state_version + 1,
              updated_at = ${input.now}
          from candidate
          where task.id = candidate.id
          returning task.id
        `);
        const row = extractExecuteRows(result)[0];
        if (!row) return null;
        return {
          id: claimedVideoRowSchema.parse(row).id,
          claimToken: input.claimToken,
        };
      });
    },
  };
}

/** 默认生产仓储；数据库失败时显式上抛并由 scheduler 记录。 */
export const defaultVideoRecoveryRepository: VideoRecoveryRepository =
  createPostgresVideoRecoveryRepository({
    async transaction(work) {
      const { db } = await import("@repo/database");
      return db.transaction(async (transaction) =>
        work({ execute: (query) => transaction.execute(query) })
      );
    },
  });
