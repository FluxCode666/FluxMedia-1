/**
 * 视频 API 创建自动恢复的结构化日志事件契约。
 *
 * 使用方：视频提交状态机和日志采集告警。该模块将低基数事件字段与失败分类集中校验，
 * 避免实现各自拼接自由文本。日志绝不包含 prompt、正文、URL、上游任务 ID 或凭据。
 */

import {
  VIDEO_SUBMISSION_FAILURE_CODES,
  type VideoSubmissionFailureCode,
} from "./video-submission-failure";

/** 日志采集可依赖的稳定事件标识。 */
export const VIDEO_SUBMISSION_RECOVERY_EVENTS = [
  "video_submission_attempt_failed",
  "video_submission_retry_scheduled",
  "video_submission_supplier_switched",
  "video_submission_capacity_wait_started",
  "video_submission_recovery_exhausted",
  "video_refund_attempt_failed",
  "video_refund_retry_exhausted",
] as const;

/** 自动恢复事件名称。 */
export type VideoSubmissionRecoveryEvent =
  (typeof VIDEO_SUBMISSION_RECOVERY_EVENTS)[number];

/** 提交事件输入中允许的失败代码集合。 */
const failureCodes = new Set<string>(VIDEO_SUBMISSION_FAILURE_CODES);

/** 结构化日志的最小安全关联字段。 */
export type VideoSubmissionRecoveryEventContext = {
  event: VideoSubmissionRecoveryEvent;
  videoTaskId: string;
  supplierId?: string;
  supplierName: string;
  model?: string;
  protocol?: "api";
  failureCode?: VideoSubmissionFailureCode;
  failureReason?: string;
  operationsReason?: string;
  requestId: string;
  attemptNumber?: number;
  memberAttemptNumber?: number;
  configuredRetryCount?: number;
  maxAttemptsSnapshot?: number;
  memberId?: string;
  externalRequestId?: string;
  httpTimeoutSeconds?: number;
  baseRetryDelaySeconds?: number;
  upstreamRetryAfterSeconds?: number;
  finalRetryDelaySeconds?: number;
  nextAttemptAt?: string;
  capacityWaitDeadlineAt?: string;
  refundAttemptCount?: number;
};

/** 校验结构化日志中的受控标识文本，避免控制字符破坏采集。 */
function assertSafeEventText(
  value: string,
  label: string,
  maxLength: number
): void {
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!normalized || normalized.length > maxLength || hasControlCharacter) {
    throw new Error(`视频提交恢复日志${label}无效`);
  }
}

/** 校验失败摘要不含 URL 或常见凭据形态，避免安全边界仅依赖调用方。 */
function assertSafeFailureReason(value: string, label: string): void {
  assertSafeEventText(value, label, 1_000);
  if (
    /https?:\/\//iu.test(value) ||
    /\b(?:authorization|api[-_]?key|token|secret|password)\s*[:=]/iu.test(
      value
    ) ||
    /\b(?:bearer|sk-)[a-z0-9._-]+/iu.test(value)
  ) {
    throw new Error(`视频提交恢复日志${label}包含敏感内容`);
  }
}

/** 校验可选整数区间。 */
function assertOptionalIntegerRange(
  value: number | undefined,
  label: string,
  minimum: number,
  maximum: number
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < minimum || value > maximum)
  ) {
    throw new Error(`视频提交恢复日志${label}无效`);
  }
}

/** 校验可选 ISO 时间。 */
function assertOptionalTimestamp(
  value: string | undefined,
  label: string
): void {
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    throw new Error(`视频提交恢复日志${label}无效`);
  }
}

/**
 * 生成满足日志标识文档的安全事件上下文。
 *
 * @param input 仅包含任务、供应商、服务端请求标识和稳定失败代码。
 * @returns 可直接传给 Pino 的扁平安全字段。
 * @sideEffects 无。
 * @failure 标识或失败代码异常时抛错，防止未知字符串破坏告警聚合。
 */
export function createVideoSubmissionRecoveryEvent(
  input: VideoSubmissionRecoveryEventContext
): VideoSubmissionRecoveryEventContext {
  if (!VIDEO_SUBMISSION_RECOVERY_EVENTS.includes(input.event)) {
    throw new Error("视频提交恢复日志事件无效");
  }
  assertSafeEventText(input.videoTaskId, "任务标识", 512);
  assertSafeEventText(input.supplierName, "供应商名称", 120);
  assertSafeEventText(input.requestId, "请求标识", 512);
  if (input.protocol !== undefined && input.protocol !== "api") {
    throw new Error("视频提交恢复日志协议无效");
  }
  if (input.supplierId) {
    assertSafeEventText(input.supplierId, "供应商标识", 512);
  }
  if (input.memberId) assertSafeEventText(input.memberId, "账号标识", 512);
  if (input.model) assertSafeEventText(input.model, "模型", 256);
  if (input.externalRequestId) {
    assertSafeEventText(input.externalRequestId, "外部请求标识", 256);
  }
  if (input.failureCode && !failureCodes.has(input.failureCode)) {
    throw new Error("视频提交恢复日志失败代码无效");
  }
  if (input.failureReason) {
    assertSafeFailureReason(input.failureReason, "用户失败原因");
  }
  if (input.operationsReason) {
    assertSafeFailureReason(input.operationsReason, "运营失败原因");
  }
  assertOptionalIntegerRange(input.attemptNumber, "尝试序号", 1, 1_000_000);
  assertOptionalIntegerRange(
    input.memberAttemptNumber,
    "账号内尝试序号",
    1,
    11
  );
  assertOptionalIntegerRange(input.configuredRetryCount, "额外重试次数", 0, 10);
  assertOptionalIntegerRange(input.maxAttemptsSnapshot, "最大尝试次数", 1, 11);
  if (
    input.memberAttemptNumber !== undefined &&
    input.maxAttemptsSnapshot !== undefined &&
    input.memberAttemptNumber > input.maxAttemptsSnapshot
  ) {
    throw new Error("视频提交恢复日志账号尝试快照无效");
  }
  assertOptionalIntegerRange(input.httpTimeoutSeconds, "创建超时", 1, 300);
  assertOptionalIntegerRange(input.baseRetryDelaySeconds, "基础等待", 0, 300);
  assertOptionalIntegerRange(
    input.upstreamRetryAfterSeconds,
    "上游等待",
    0,
    300
  );
  assertOptionalIntegerRange(input.finalRetryDelaySeconds, "最终等待", 0, 300);
  assertOptionalIntegerRange(input.refundAttemptCount, "退款尝试次数", 1, 3);
  assertOptionalTimestamp(input.nextAttemptAt, "下次计划时间");
  assertOptionalTimestamp(input.capacityWaitDeadlineAt, "容量等待截止时间");
  if (
    input.configuredRetryCount !== undefined &&
    input.maxAttemptsSnapshot !== undefined &&
    input.maxAttemptsSnapshot !== input.configuredRetryCount + 1
  ) {
    throw new Error("视频提交恢复日志重试快照无效");
  }
  return input;
}
