/**
 * 视频任务创建的数据库准入门。
 *
 * 职责：按 Principal 作用域串行化“检查现有幂等任务、统计活跃任务”的决策，阻止
 * 并发请求绕过 created 队列上限。调用方必须在同一事务内紧接着插入任务。
 * 使用方：video.generate 的持久任务创建与真实 PostgreSQL 并发测试。
 */
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

export const MAX_ACTIVE_VIDEO_TASKS_PER_PRINCIPAL = 5;

const admissionInputSchema = z.object({
  taskId: z.string().trim().min(1).max(512),
  principalScope: z.string().trim().min(1).max(512),
  maxActiveTasks: z.number().int().positive().max(100),
});
const activeCountRowSchema = z.object({
  activeCount: z
    .union([z.number(), z.string()])
    .transform(Number)
    .pipe(z.number().int().nonnegative()),
});

/** 活跃视频任务达到 Principal 上限。 */
export class VideoActiveTaskLimitError extends Error {
  constructor(readonly maxActiveTasks: number) {
    super(`每个调用身份最多同时保留 ${maxActiveTasks} 个活跃视频任务`);
    this.name = "VideoActiveTaskLimitError";
  }
}

/** 准入逻辑所需的参数化 SQL 事务端口。 */
export interface VideoTaskAdmissionTransaction {
  execute(query: SQL): Promise<unknown>;
}

/** 准入结果；existing 表示同一幂等任务已由并发请求创建。 */
export type VideoTaskAdmissionResult = "admitted" | "existing";

/**
 * 在调用方事务内获得 Principal 锁并检查活跃任务上限。
 *
 * @returns admitted 时调用方必须继续插入；existing 时不得重复插入或创建回调。
 * @throws VideoActiveTaskLimitError 当非终态任务已达到上限。
 */
export async function admitVideoTaskCreation(
  transaction: VideoTaskAdmissionTransaction,
  rawInput: {
    taskId: string;
    principalScope: string;
    maxActiveTasks?: number;
  }
): Promise<VideoTaskAdmissionResult> {
  const input = admissionInputSchema.parse({
    ...rawInput,
    maxActiveTasks:
      rawInput.maxActiveTasks ?? MAX_ACTIVE_VIDEO_TASKS_PER_PRINCIPAL,
  });

  // WHY：应用副本共享同一 advisory xact lock，且锁随事务自动释放；检查与插入之间
  // 不留竞态窗口。哈希碰撞只会额外串行化，不会放宽安全边界。
  await transaction.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${input.principalScope}, 0))
  `);
  const existingResult = await transaction.execute(sql`
    select id
    from video_generation
    where id = ${input.taskId}
    limit 1
  `);
  if (extractExecuteRows(existingResult).length > 0) return "existing";

  const countResult = await transaction.execute(sql`
    select count(*)::integer as "activeCount"
    from video_generation
    where principal_scope = ${input.principalScope}
      and stage not in ('completed', 'failed')
  `);
  const countValue = extractExecuteRows(countResult)[0];
  const activeCount = countValue
    ? activeCountRowSchema.parse(countValue).activeCount
    : 0;
  if (activeCount >= input.maxActiveTasks) {
    throw new VideoActiveTaskLimitError(input.maxActiveTasks);
  }
  return "admitted";
}
