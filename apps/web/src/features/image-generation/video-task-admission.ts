/**
 * 视频任务创建的数据库准入门。
 *
 * 职责：按用户串行化“检查现有幂等任务、统计活跃任务”的决策，同时限制用户总量
 * 与单 Principal 数量，阻止多建 API Key 或并发请求绕过 created 队列上限。
 * 使用方：video.generate 的持久任务创建与真实 PostgreSQL 并发测试。
 */
import { randomUUID } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

export const MAX_ACTIVE_VIDEO_TASKS_PER_PRINCIPAL = 5;
export const MAX_ACTIVE_VIDEO_TASKS_PER_USER = 10;
export const VIDEO_STAGING_RESERVATION_TTL_MS = 15 * 60_000;

const admissionInputSchema = z.object({
  taskId: z.string().trim().min(1).max(512),
  userId: z.string().trim().min(1).max(512),
  principalScope: z.string().trim().min(1).max(512),
  maxPrincipalActiveTasks: z.number().int().positive().max(100),
  maxUserActiveTasks: z.number().int().positive().max(100),
});
const activeCountRowSchema = z.object({
  principalActiveCount: z
    .union([z.number(), z.string()])
    .transform(Number)
    .pipe(z.number().int().nonnegative()),
  userActiveCount: z
    .union([z.number(), z.string()])
    .transform(Number)
    .pipe(z.number().int().nonnegative()),
});

/** 活跃视频任务达到 Principal 或用户上限。 */
export class VideoActiveTaskLimitError extends Error {
  constructor(
    readonly limitKind: "principal" | "user",
    readonly maxActiveTasks: number
  ) {
    super(
      limitKind === "user"
        ? `每个用户最多同时保留 ${maxActiveTasks} 个活跃视频任务`
        : `每个调用身份最多同时保留 ${maxActiveTasks} 个活跃视频任务`
    );
    this.name = "VideoActiveTaskLimitError";
  }
}

/** 同一幂等任务已有请求正在转存输入。 */
export class VideoTaskStagingInProgressError extends Error {
  constructor() {
    super("同一视频任务正在完成输入转存，请稍后重试");
    this.name = "VideoTaskStagingInProgressError";
  }
}

/** 准入逻辑所需的参数化 SQL 事务端口。 */
export interface VideoTaskAdmissionTransaction {
  execute(query: SQL): Promise<unknown>;
}

/** staging reservation 需要的最小事务数据库端口。 */
export interface VideoTaskAdmissionDatabase {
  transaction<T>(
    work: (transaction: VideoTaskAdmissionTransaction) => Promise<T>
  ): Promise<T>;
}

/** 准入结果；existing 表示同一幂等任务已由并发请求创建。 */
export type VideoTaskAdmissionResult = "admitted" | "existing";

/** 转存前持久预留结果；reserved 才允许发生对象存储 I/O。 */
export type VideoTaskPreflightResult =
  | { status: "reserved"; reservationToken: string }
  | { status: "existing" };

export interface VideoTaskAdmissionInput {
  taskId: string;
  userId: string;
  principalScope: string;
  maxPrincipalActiveTasks?: number;
  maxUserActiveTasks?: number;
}

/** 归一化准入输入，使廉价预检和事务终检使用完全相同的上限。 */
function parseAdmissionInput(rawInput: VideoTaskAdmissionInput) {
  return admissionInputSchema.parse({
    ...rawInput,
    maxPrincipalActiveTasks:
      rawInput.maxPrincipalActiveTasks ?? MAX_ACTIVE_VIDEO_TASKS_PER_PRINCIPAL,
    maxUserActiveTasks:
      rawInput.maxUserActiveTasks ?? MAX_ACTIVE_VIDEO_TASKS_PER_USER,
  });
}

/**
 * 检查幂等任务和双层活跃上限；事务调用方必须先获得对应用户锁。
 *
 * 独立调用可作为转存大媒体前的廉价预检；最终安全事实仍由事务准入保证。
 */
export async function checkVideoTaskCapacity(
  executor: VideoTaskAdmissionTransaction,
  rawInput: VideoTaskAdmissionInput
): Promise<VideoTaskAdmissionResult> {
  const input = parseAdmissionInput(rawInput);
  const existingResult = await executor.execute(sql`
    select id
    from video_generation
    where id = ${input.taskId}
    limit 1
  `);
  if (extractExecuteRows(existingResult).length > 0) return "existing";

  const countResult = await executor.execute(sql`
    select
      count(*) filter (
        where principal_scope = ${input.principalScope}
      )::integer as "principalActiveCount",
      count(*)::integer as "userActiveCount"
    from video_generation
    where user_id = ${input.userId}
      and stage not in ('completed', 'failed')
  `);
  const countValue = extractExecuteRows(countResult)[0];
  const counts = countValue
    ? activeCountRowSchema.parse(countValue)
    : { principalActiveCount: 0, userActiveCount: 0 };
  if (counts.userActiveCount >= input.maxUserActiveTasks) {
    throw new VideoActiveTaskLimitError("user", input.maxUserActiveTasks);
  }
  if (counts.principalActiveCount >= input.maxPrincipalActiveTasks) {
    throw new VideoActiveTaskLimitError(
      "principal",
      input.maxPrincipalActiveTasks
    );
  }
  return "admitted";
}

/**
 * 在用户锁内持久预留一个 staging 槽位。
 *
 * 活跃任务与未过期 reservation 合并计数，因此并发请求无法在任务插入前同时通过
 * 非锁定预检并放大对象存储 I/O。reservation token 防止旧请求删除新请求的槽位。
 */
export async function reserveVideoTaskStaging(
  database: VideoTaskAdmissionDatabase,
  rawInput: VideoTaskAdmissionInput,
  options: {
    now: Date;
    expiresAt: Date;
    reservationToken: string;
  }
): Promise<VideoTaskPreflightResult> {
  const input = parseAdmissionInput(rawInput);
  const reservationToken = z
    .string()
    .trim()
    .min(1)
    .max(512)
    .parse(options.reservationToken);
  if (options.expiresAt.getTime() <= options.now.getTime()) {
    throw new Error("视频 staging reservation 到期时间无效");
  }
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`video-user:${input.userId}`}, 0)
      )
    `);
    const existingTask = await transaction.execute(sql`
      select id
      from video_generation
      where id = ${input.taskId}
      limit 1
    `);
    if (extractExecuteRows(existingTask).length > 0) {
      return { status: "existing" };
    }
    await transaction.execute(sql`
      delete from video_task_staging_reservation
      where user_id = ${input.userId}
        and expires_at <= ${options.now}
    `);
    const existingReservation = await transaction.execute(sql`
      select task_id
      from video_task_staging_reservation
      where task_id = ${input.taskId}
      limit 1
    `);
    if (extractExecuteRows(existingReservation).length > 0) {
      throw new VideoTaskStagingInProgressError();
    }

    const countResult = await transaction.execute(sql`
      select
        (
          select count(*)
          from video_generation
          where user_id = ${input.userId}
            and principal_scope = ${input.principalScope}
            and stage not in ('completed', 'failed')
        ) + (
          select count(*)
          from video_task_staging_reservation
          where user_id = ${input.userId}
            and principal_scope = ${input.principalScope}
            and expires_at > ${options.now}
        ) as "principalActiveCount",
        (
          select count(*)
          from video_generation
          where user_id = ${input.userId}
            and stage not in ('completed', 'failed')
        ) + (
          select count(*)
          from video_task_staging_reservation
          where user_id = ${input.userId}
            and expires_at > ${options.now}
        ) as "userActiveCount"
    `);
    const countValue = extractExecuteRows(countResult)[0];
    const counts = countValue
      ? activeCountRowSchema.parse(countValue)
      : { principalActiveCount: 0, userActiveCount: 0 };
    if (counts.userActiveCount >= input.maxUserActiveTasks) {
      throw new VideoActiveTaskLimitError("user", input.maxUserActiveTasks);
    }
    if (counts.principalActiveCount >= input.maxPrincipalActiveTasks) {
      throw new VideoActiveTaskLimitError(
        "principal",
        input.maxPrincipalActiveTasks
      );
    }
    const inserted = await transaction.execute(sql`
      insert into video_task_staging_reservation (
        task_id,
        reservation_token,
        user_id,
        principal_scope,
        expires_at,
        created_at,
        updated_at
      )
      values (
        ${input.taskId},
        ${reservationToken},
        ${input.userId},
        ${input.principalScope},
        ${options.expiresAt},
        ${options.now},
        ${options.now}
      )
      returning task_id
    `);
    if (extractExecuteRows(inserted).length !== 1) {
      throw new Error("视频 staging reservation 写入失败");
    }
    return { status: "reserved", reservationToken };
  });
}

/** 在媒体转存前使用生产数据库原子占用 staging 槽位。 */
export async function preflightVideoTaskCreation(
  input: VideoTaskAdmissionInput
): Promise<VideoTaskPreflightResult> {
  const { db } = await import("@repo/database");
  const now = new Date();
  return reserveVideoTaskStaging(
    {
      transaction: (work) =>
        db.transaction((transaction) =>
          work({ execute: (query) => transaction.execute(query) })
        ),
    },
    input,
    {
      now,
      expiresAt: new Date(now.getTime() + VIDEO_STAGING_RESERVATION_TTL_MS),
      reservationToken: randomUUID(),
    }
  );
}

/** staging 失败后按 token 释放当前请求的槽位；旧请求不能删掉新 reservation。 */
export async function releaseVideoTaskStagingReservation(input: {
  taskId: string;
  userId: string;
  reservationToken: string;
}): Promise<boolean> {
  const { db } = await import("@repo/database");
  const result = await db.execute(sql`
    delete from video_task_staging_reservation
    where task_id = ${input.taskId}
      and user_id = ${input.userId}
      and reservation_token = ${input.reservationToken}
    returning task_id
  `);
  return extractExecuteRows(result).length === 1;
}

/**
 * 在最终任务事务内消费 staging reservation。
 *
 * admitted 分支必须命中一行，保证任务只能替换自己已计入上限的槽位；existing 分支
 * 允许 reservation 已被另一幂等执行消费。
 */
export async function consumeVideoTaskStagingReservation(
  transaction: VideoTaskAdmissionTransaction,
  input: {
    taskId: string;
    userId: string;
    reservationToken: string;
    required: boolean;
  }
): Promise<boolean> {
  const result = await transaction.execute(sql`
    delete from video_task_staging_reservation
    where task_id = ${input.taskId}
      and user_id = ${input.userId}
      and reservation_token = ${input.reservationToken}
    returning task_id
  `);
  const consumed = extractExecuteRows(result).length === 1;
  if (input.required && !consumed) {
    throw new Error("视频 staging reservation 缺失或已过期");
  }
  return consumed;
}

/**
 * 在调用方事务内获得用户锁并检查双层活跃任务上限。
 *
 * @returns admitted 时调用方必须继续插入；existing 时不得重复插入或创建回调。
 * @throws VideoActiveTaskLimitError 当非终态任务已达到上限。
 */
export async function admitVideoTaskCreation(
  transaction: VideoTaskAdmissionTransaction,
  rawInput: VideoTaskAdmissionInput
): Promise<VideoTaskAdmissionResult> {
  const input = parseAdmissionInput(rawInput);

  // WHY：按 userId 统一加锁，使不同 API Key 也进入同一临界区；应用副本共享该锁且
  // 随事务自动释放。哈希碰撞只会额外串行化，不会放宽安全边界。
  await transaction.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`video-user:${input.userId}`}, 0)
    )
  `);
  return checkVideoTaskCapacity(transaction, input);
}
