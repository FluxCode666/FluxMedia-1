/**
 * 视频公开状态投影。
 *
 * 使用方：UOL、站内与外部视频 API、回调和视频历史读取。持久化的 status/stage
 * 仍保留内部执行语义；本模块只负责把它们安全地投影为四个公开状态，图片历史不得调用。
 */

import {
  type VideoPublicStatus,
  videoPublicStatusSchema,
} from "@repo/shared/uol/operations/video-generation";
import { type SQL, sql } from "drizzle-orm";

export { type VideoPublicStatus, videoPublicStatusSchema };

/**
 * 将持久化视频状态和执行阶段投影为公开四态。
 *
 * @param status 持久化 status（旧数据可能是 pending/running/processing）。
 * @param stage 可选执行阶段，用于区分 created/charged 与已开始执行的任务。
 * @param capacityWaitDeadlineAt 首次获租前已固定的容量等待截止时间。
 * @returns 只返回 queued、in_progress、completed、failed 之一。
 * @sideEffects 无。
 * @failure 未知状态按 in_progress 处理，避免把正在执行的任务误报为排队或失败。
 */
export function toVideoPublicStatus(
  status: string,
  stage?: string,
  capacityWaitDeadlineAt?: Date | string | null
): VideoPublicStatus {
  if (status === "completed" || stage === "completed") return "completed";
  if (status === "failed" || stage === "failed" || stage === "refunding") {
    return "failed";
  }
  if (stage === "created" && capacityWaitDeadlineAt) return "in_progress";
  if (
    stage === "created" ||
    stage === "charged" ||
    (stage === undefined && status === "pending")
  ) {
    return "queued";
  }
  return "in_progress";
}

/**
 * 迁移窗口内把旧人工态投影为 in_progress。
 *
 * @deprecated 仅用于升级前遗留 API 行的公开查询；下个版本在证明遗留行数量为零后移除。
 */
export function toLegacyVideoPublicStatus(
  status: string,
  stage?: string,
  capacityWaitDeadlineAt?: Date | string | null
): VideoPublicStatus {
  if (stage === "submit_uncertain" || status === "needs_attention") {
    return "in_progress";
  }
  return toVideoPublicStatus(status, stage, capacityWaitDeadlineAt);
}

/**
 * 为视频历史查询构造与运行时投影一致的 SQL CASE。
 *
 * @param statusColumn video_generation.status 列表达式。
 * @param stageColumn video_generation.stage 列表达式。
 * @param capacityWaitDeadlineColumn 可选容量等待截止列。
 * @returns 只产生公开四态的参数化 SQL 表达式。
 * @sideEffects 无。
 * @failure 未知和遗留活动阶段统一投影为 in_progress。
 */
export function buildVideoPublicStatusSql(
  statusColumn: SQL,
  stageColumn: SQL,
  capacityWaitDeadlineColumn?: SQL
): SQL {
  return sql`case
    when ${statusColumn} = 'completed' or ${stageColumn} = 'completed'
      then 'completed'
    when ${statusColumn} = 'failed'
      or ${stageColumn} in ('failed', 'refunding')
      then 'failed'
    ${
      capacityWaitDeadlineColumn
        ? sql`when ${stageColumn} = 'created'
            and ${capacityWaitDeadlineColumn} is not null
          then 'in_progress'`
        : sql``
    }
    when ${stageColumn} in ('created', 'charged') then 'queued'
    else 'in_progress'
  end`;
}

/**
 * 把视频公开状态筛选转换为持久 status/stage 谓词。
 *
 * @param publicStatus 用户请求的公开视频状态。
 * @param statusColumn video_generation.status 列表达式。
 * @param stageColumn video_generation.stage 列表达式。
 * @param capacityWaitDeadlineColumn 可选容量等待截止列。
 * @returns 与 buildVideoPublicStatusSql 严格一致的参数化 SQL 谓词。
 * @sideEffects 无。
 */
export function buildVideoPublicStatusPredicate(
  publicStatus: VideoPublicStatus,
  statusColumn: SQL,
  stageColumn: SQL,
  capacityWaitDeadlineColumn?: SQL
): SQL {
  return sql`${buildVideoPublicStatusSql(
    statusColumn,
    stageColumn,
    capacityWaitDeadlineColumn
  )} = ${publicStatus}`;
}
