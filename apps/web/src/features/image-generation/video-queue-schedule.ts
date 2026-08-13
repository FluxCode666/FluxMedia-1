/**
 * 视频 Redis MQ 重投时间策略。
 *
 * 职责：只根据 PostgreSQL 持久阶段、最早轮询时间与 claim 租约计算下一次投递；
 * Worker 和恢复扫描共用。函数不访问数据库或 Redis，可在 DB-free 测试中验证。
 */

/** charged/submitting 中断后自动恢复前的安全观察窗口。 */
export const VIDEO_SUBMISSION_RECOVERY_GRACE_MS = 21 * 60_000;

/** 容量暂满时的固定重试间隔，避免每秒轮询放大账号池和队列压力。 */
export const VIDEO_CAPACITY_RETRY_DELAY_MS = 15_000;

/** 计算视频重投所需的最小持久字段。 */
export interface VideoQueueScheduleRow {
  id: string;
  stage: string;
  stateVersion: number;
  nextPollAt: Date | null;
  claimExpiresAt: Date | null;
  submitStartedAt: Date | null;
  refundExhaustedAt?: Date | null;
  updatedAt: Date;
}

/** 视频下一次 MQ 投递描述。 */
export interface VideoQueueSchedule {
  taskId: string;
  stateVersion: number;
  runAt: Date;
}

/** 返回多个时间中的最晚有效值，避免在 claim 或观察窗口内抢跑。 */
function latestDate(candidates: Array<Date | null>): Date {
  return new Date(
    Math.max(
      ...candidates
        .filter((value): value is Date => value instanceof Date)
        .map((value) => value.getTime())
    )
  );
}

/**
 * 计算容量等待的下一次尝试时间。
 *
 * @param now 当前时钟。
 * @param deadline 本轮容量等待的持久截止时间。
 * @returns 固定退避后的时刻，但绝不越过截止时间。
 * @sideEffects 无。
 * @failure 调用方必须提供合法日期；非法持久事实由上层状态机校验。
 */
export function resolveVideoCapacityRetryAt(now: Date, deadline: Date): Date {
  return new Date(
    Math.min(deadline.getTime(), now.getTime() + VIDEO_CAPACITY_RETRY_DELAY_MS)
  );
}

/**
 * 计算非终态视频任务下一次 Redis MQ 投递时间。
 *
 * @param row PostgreSQL 当前任务快照。
 * @param now 当前时钟；测试可固定。
 * @returns 可恢复任务的确定性投递描述；终态或人工核对态返回 null。
 */
export function resolveVideoQueueSchedule(
  row: VideoQueueScheduleRow,
  now = new Date()
): VideoQueueSchedule | null {
  if (
    ["completed", "failed", "submit_uncertain"].includes(row.stage) ||
    (row.stage === "refunding" && row.refundExhaustedAt)
  ) {
    return null;
  }

  let readyAt = row.nextPollAt ?? now;
  if (row.stage === "charged") {
    readyAt = new Date(
      row.updatedAt.getTime() + VIDEO_SUBMISSION_RECOVERY_GRACE_MS
    );
  } else if (row.stage === "submitting") {
    readyAt = new Date(
      (row.submitStartedAt ?? row.updatedAt).getTime() +
        VIDEO_SUBMISSION_RECOVERY_GRACE_MS
    );
  }

  return {
    taskId: row.id,
    stateVersion: row.stateVersion,
    runAt: latestDate([now, readyAt, row.claimExpiresAt]),
  };
}
