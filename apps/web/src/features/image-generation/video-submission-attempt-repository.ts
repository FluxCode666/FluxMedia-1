/**
 * API 视频创建提交尝试的 PostgreSQL 账本仓储。
 *
 * 职责：每次真实外呼前原子固定账号级重试配置和序号，并由数据库上限与唯一键阻止
 * 多 Worker 越界。账本只保存安全身份和失败摘要，不保存请求正文、URL、凭据或任务 ID。
 */
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

const identifierSchema = z.string().trim().min(1).max(512);

const reserveInputSchema = z
  .object({
    attemptId: identifierSchema,
    videoGenerationId: identifierSchema,
    backendMemberId: identifierSchema,
    requestId: identifierSchema,
    videoSubmissionRetryCount: z.number().int().min(0).max(10),
    supplierNameSnapshot: z.string().trim().min(1).max(120),
    apiAdapterMemberId: identifierSchema,
    apiAdapterVersionId: identifierSchema,
    now: z.date(),
  })
  .strict();

const attemptRowSchema = z.object({
  id: identifierSchema,
  video_generation_id: identifierSchema,
  backend_member_id: identifierSchema,
  member_attempt_number: z.coerce.number().int().positive(),
  global_attempt_number: z.coerce.number().int().positive(),
  request_id: identifierSchema,
  retry_count_snapshot: z.coerce.number().int().min(0).max(10),
  max_attempts_snapshot: z.coerce.number().int().min(1).max(11),
  supplier_name_snapshot: z.string().trim().min(1).max(120),
  api_adapter_member_id: identifierSchema,
  api_adapter_version_id: identifierSchema,
  created_at: z.coerce.date(),
});

/** 一次已获准发起真实外呼的持久账本记录。 */
export interface ReservedVideoSubmissionAttempt {
  id: string;
  videoGenerationId: string;
  backendMemberId: string;
  memberAttemptNumber: number;
  globalAttemptNumber: number;
  requestId: string;
  retryCountSnapshot: number;
  maxAttemptsSnapshot: number;
  supplierNameSnapshot: string;
  apiAdapterMemberId: string;
  apiAdapterVersionId: string;
  createdAt: Date;
}

/** 预留下一次 API 视频创建外呼所需输入。 */
export type ReserveVideoSubmissionAttemptInput = z.input<
  typeof reserveInputSchema
>;

/** 尝试账本事务只依赖参数化 SQL。 */
export interface VideoSubmissionAttemptTransaction {
  execute(query: SQL): Promise<unknown>;
}

/** 生产数据库和 PostgreSQL 集成测试共用的事务端口。 */
export interface VideoSubmissionAttemptDatabase {
  transaction<T>(
    work: (transaction: VideoSubmissionAttemptTransaction) => Promise<T>
  ): Promise<T>;
}

/** 视频创建状态机使用的最小尝试账本接口。 */
export interface VideoSubmissionAttemptRepository {
  reserveNext(
    input: ReserveVideoSubmissionAttemptInput
  ): Promise<ReservedVideoSubmissionAttempt | null>;
}

/**
 * 创建 PostgreSQL 尝试账本仓储。
 *
 * @param database 可注入的事务与参数化 SQL 端口。
 * @returns 外呼前原子预留下一序号的仓储。
 * @sideEffects 成功时插入一条不可变尝试记录。
 * @failure 数据库错误显式上抛；达到快照上限或唯一键竞争返回 null。
 */
export function createPostgresVideoSubmissionAttemptRepository(
  database: VideoSubmissionAttemptDatabase
): VideoSubmissionAttemptRepository {
  return {
    async reserveNext(rawInput) {
      const input = reserveInputSchema.parse(rawInput);
      return database.transaction(async (transaction) => {
        // WHY：任务行锁把“读取历史快照、计算序号、判断上限和插入”串成同一临界区；
        // 唯一键仍是最后一道并发兜底，任何未返回行都必须禁止外呼。
        const result = await transaction.execute(sql`
          with locked_task as (
            select id
            from video_generation
            where id = ${input.videoGenerationId}
              and stage in ('charged', 'submitting', 'retrying')
              and upstream_job_id is null
            for update
          ), member_snapshot as (
            select
              coalesce(max(retry_count_snapshot), ${input.videoSubmissionRetryCount})
                as retry_count_snapshot,
              coalesce(max(max_attempts_snapshot), ${
                input.videoSubmissionRetryCount + 1
              }) as max_attempts_snapshot,
              coalesce(max(member_attempt_number), 0) + 1
                as member_attempt_number
            from video_generation_submission_attempt
            where video_generation_id = ${input.videoGenerationId}
              and backend_member_id = ${input.backendMemberId}
          ), global_sequence as (
            select coalesce(max(global_attempt_number), 0) + 1
              as global_attempt_number
            from video_generation_submission_attempt
            where video_generation_id = ${input.videoGenerationId}
          ), inserted as (
            insert into video_generation_submission_attempt (
              id,
              video_generation_id,
              backend_member_id,
              member_attempt_number,
              global_attempt_number,
              request_id,
              retry_count_snapshot,
              max_attempts_snapshot,
              supplier_name_snapshot,
              api_adapter_member_id,
              api_adapter_version_id,
              created_at,
              updated_at
            )
            select
              ${input.attemptId},
              locked_task.id,
              ${input.backendMemberId},
              member_snapshot.member_attempt_number,
              global_sequence.global_attempt_number,
              ${input.requestId},
              member_snapshot.retry_count_snapshot,
              member_snapshot.max_attempts_snapshot,
              ${input.supplierNameSnapshot},
              ${input.apiAdapterMemberId},
              ${input.apiAdapterVersionId},
              ${input.now},
              ${input.now}
            from locked_task
            cross join member_snapshot
            cross join global_sequence
            where member_snapshot.member_attempt_number
              <= member_snapshot.max_attempts_snapshot
            on conflict do nothing
            returning *
          )
          select * from inserted
        `);
        const row = extractExecuteRows(result)[0];
        if (!row) return null;
        const parsed = attemptRowSchema.parse(row);
        return {
          id: parsed.id,
          videoGenerationId: parsed.video_generation_id,
          backendMemberId: parsed.backend_member_id,
          memberAttemptNumber: parsed.member_attempt_number,
          globalAttemptNumber: parsed.global_attempt_number,
          requestId: parsed.request_id,
          retryCountSnapshot: parsed.retry_count_snapshot,
          maxAttemptsSnapshot: parsed.max_attempts_snapshot,
          supplierNameSnapshot: parsed.supplier_name_snapshot,
          apiAdapterMemberId: parsed.api_adapter_member_id,
          apiAdapterVersionId: parsed.api_adapter_version_id,
          createdAt: parsed.created_at,
        };
      });
    },
  };
}

/** 默认生产尝试账本；数据库失败显式上抛给视频状态机。 */
export const defaultVideoSubmissionAttemptRepository =
  createPostgresVideoSubmissionAttemptRepository({
    async transaction(work) {
      const { db } = await import("@repo/database");
      return db.transaction(async (transaction) =>
        work({ execute: (query) => transaction.execute(query) })
      );
    },
  });
