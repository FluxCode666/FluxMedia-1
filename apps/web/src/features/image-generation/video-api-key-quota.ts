/**
 * 视频任务的 API Key 配额幂等仓储。
 *
 * 职责：把任务级预留状态与 external_api_key.credits_used 放在同一事务内更新，使
 * worker 崩溃重放、并发退款和用户账本失败补偿都不会重复增减 API Key 配额。
 * 使用方：视频持久 worker；真实 PostgreSQL 测试复用同一参数化 SQL 实现。
 */
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  ExternalApiKeyQuotaExceededError,
  getExternalApiKeyQuotaRemaining,
  roundQuotaCredits,
} from "@/features/external-api/quota-math";
import { extractExecuteRows } from "@/server/database-result";

const identifierSchema = z.string().trim().min(1).max(512);
const numericValueSchema = z
  .union([z.number(), z.string()])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
const videoQuotaRowSchema = z.object({
  userId: identifierSchema,
  apiKeyId: identifierSchema.nullable(),
  reserved: numericValueSchema,
});
const externalApiKeyQuotaRowSchema = z.object({
  creditLimit: numericValueSchema.nullable(),
  creditsUsed: numericValueSchema,
  isActive: z.boolean(),
});

/** 视频配额仓储使用的参数化 SQL 事务端口。 */
export interface VideoApiKeyQuotaTransaction {
  execute(query: SQL): Promise<unknown>;
}

/** 生产数据库与真实 PostgreSQL 测试共用的最小事务入口。 */
export interface VideoApiKeyQuotaDatabase {
  transaction<T>(
    work: (transaction: VideoApiKeyQuotaTransaction) => Promise<T>
  ): Promise<T>;
}

/** 视频任务级 API Key 配额仓储。 */
export interface VideoApiKeyQuotaRepository {
  reserve(input: { videoId: string; amount: number }): Promise<number>;
  refund(input: { videoId: string }): Promise<number>;
}

/** 解析一条受行锁保护的视频任务；缺失时显式失败。 */
async function lockVideoQuotaRow(
  transaction: VideoApiKeyQuotaTransaction,
  videoId: string
) {
  const result = await transaction.execute(sql`
    select
      user_id as "userId",
      api_key_id as "apiKeyId",
      api_key_credits_reserved as "reserved"
    from video_generation
    where id = ${videoId}
    for update
  `);
  const row = extractExecuteRows(result)[0];
  if (!row) throw new Error("视频任务不存在，无法更新 API Key 配额");
  return videoQuotaRowSchema.parse(row);
}

/** 创建 PostgreSQL 视频 API Key 配额仓储。 */
export function createPostgresVideoApiKeyQuotaRepository(
  database: VideoApiKeyQuotaDatabase
): VideoApiKeyQuotaRepository {
  return {
    async reserve(rawInput) {
      const videoId = identifierSchema.parse(rawInput.videoId);
      const amount = roundQuotaCredits(rawInput.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("视频 API Key 配额预留金额无效");
      }

      return database.transaction(async (transaction) => {
        const task = await lockVideoQuotaRow(transaction, videoId);
        const current = roundQuotaCredits(task.reserved);
        if (!task.apiKeyId) {
          if (current !== 0) {
            throw new Error("站内视频任务存在异常 API Key 配额预留");
          }
          return 0;
        }
        if (current === amount) return current;
        if (current !== 0) {
          throw new Error("视频任务的 API Key 配额预留金额发生冲突");
        }

        const updatedResult = await transaction.execute(sql`
          update external_api_key
          set credits_used = credits_used + ${amount},
              updated_at = now()
          where id = ${task.apiKeyId}
            and user_id = ${task.userId}
            and is_active = true
            and (
              credit_limit is null
              or credit_limit - credits_used >= ${amount}
            )
          returning
            credit_limit as "creditLimit",
            credits_used as "creditsUsed",
            is_active as "isActive"
        `);
        if (extractExecuteRows(updatedResult)[0]) {
          const taskResult = await transaction.execute(sql`
            update video_generation
            set api_key_credits_reserved = ${amount}
            where id = ${videoId}
              and api_key_credits_reserved = 0
            returning id
          `);
          if (extractExecuteRows(taskResult).length !== 1) {
            throw new Error("视频任务的 API Key 配额预留状态写入失败");
          }
          return amount;
        }

        const quotaResult = await transaction.execute(sql`
          select
            credit_limit as "creditLimit",
            credits_used as "creditsUsed",
            is_active as "isActive"
          from external_api_key
          where id = ${task.apiKeyId}
            and user_id = ${task.userId}
          limit 1
        `);
        const quotaValue = extractExecuteRows(quotaResult)[0];
        if (!quotaValue) {
          throw new Error("视频任务引用的 API Key 不存在");
        }
        const quota = externalApiKeyQuotaRowSchema.parse(quotaValue);
        if (!quota.isActive) throw new Error("视频任务引用的 API Key 已停用");
        const limit = quota.creditLimit;
        const used = roundQuotaCredits(quota.creditsUsed);
        const remaining = getExternalApiKeyQuotaRemaining(limit, used) ?? 0;
        throw new ExternalApiKeyQuotaExceededError(
          amount,
          remaining,
          limit,
          used
        );
      });
    },

    async refund(rawInput) {
      const videoId = identifierSchema.parse(rawInput.videoId);
      return database.transaction(async (transaction) => {
        const task = await lockVideoQuotaRow(transaction, videoId);
        const amount = roundQuotaCredits(task.reserved);
        if (!task.apiKeyId || amount <= 0) return 0;

        const keyResult = await transaction.execute(sql`
          update external_api_key
          set credits_used = greatest(0, credits_used - ${amount}),
              updated_at = now()
          where id = ${task.apiKeyId}
            and user_id = ${task.userId}
          returning id
        `);
        if (extractExecuteRows(keyResult).length !== 1) {
          throw new Error("视频任务引用的 API Key 不存在，无法归还配额");
        }
        const taskResult = await transaction.execute(sql`
          update video_generation
          set api_key_credits_reserved = 0
          where id = ${videoId}
            and api_key_credits_reserved = ${amount}
          returning id
        `);
        if (extractExecuteRows(taskResult).length !== 1) {
          throw new Error("视频任务的 API Key 配额归还状态写入失败");
        }
        return amount;
      });
    },
  };
}

/** 默认生产仓储；动态加载数据库以保持本模块可做 DB-free 单测。 */
export const defaultVideoApiKeyQuotaRepository: VideoApiKeyQuotaRepository =
  createPostgresVideoApiKeyQuotaRepository({
    async transaction(work) {
      const { db } = await import("@repo/database");
      return db.transaction(async (transaction) =>
        work({ execute: (query) => transaction.execute(query) })
      );
    },
  });
