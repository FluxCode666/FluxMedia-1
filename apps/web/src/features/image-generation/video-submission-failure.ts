/**
 * API 视频创建失败的稳定分类和安全原因契约。
 *
 * 职责：把网络、HTTP 与受控响应脚本事实收敛为同账号重试、切号、退款或已接受；
 * 使用方是视频创建状态机、尝试账本和运维日志。不得传入或返回原始响应正文。
 */
import type { ApiUpstreamResponseResult } from "@repo/shared/image-backend/api-upstream-script-contract";
import { z } from "zod";

/** 账本、任务与日志共同使用的低基数失败代码。 */
export const VIDEO_SUBMISSION_FAILURE_CODES = [
  "submission_timeout",
  "network_error",
  "response_read_failed",
  "response_parse_failed",
  "missing_upstream_task_id",
  "rate_limited",
  "upstream_unavailable",
  "authentication_failed",
  "permission_denied",
  "invalid_request",
  "moderation_rejected",
  "submission_conflict",
  "capacity_wait_timeout",
  "no_eligible_api_account",
  "unknown_submission_failure",
] as const;

/** API 视频提交稳定失败代码。 */
export type VideoSubmissionFailureCode =
  (typeof VIDEO_SUBMISSION_FAILURE_CODES)[number];

/** 创建失败后的唯一恢复动作。 */
export type VideoSubmissionFailureAction =
  | "retry_same_member"
  | "switch_member"
  | "terminate_and_refund"
  | "accepted";

/** 受控响应脚本可提供的失败分类。 */
type ScriptedFailureCategory = Extract<
  ApiUpstreamResponseResult,
  { status: "failed" }
>["error"]["category"];

/** 分类器只消费不含正文和凭据的失败事实。 */
export type VideoSubmissionFailureInput = {
  kind?:
    | "timeout"
    | "network"
    | "response_read"
    | "response_parse"
    | "missing_task_id"
    | "unknown";
  statusCode?: number;
  acceptedTaskId?: string;
  scriptedCategory?: ScriptedFailureCategory;
  scriptedRetryable?: boolean;
};

/** 分类器输出可安全持久化和展示的稳定事实。 */
export type VideoSubmissionFailureDecision = {
  action: VideoSubmissionFailureAction;
  failureCode?: VideoSubmissionFailureCode;
  userReason?: string;
  operationsReason?: string;
};

/** 同账号重试的持久排程结果。 */
export type VideoSubmissionRetrySchedule = {
  baseDelaySeconds: number;
  retryAfterSeconds?: number;
  finalDelaySeconds: number;
  nextAttemptAt: Date;
};

/** 遗留人工态任务是否具备可重建的 API 创建事实。 */
export type LegacyUncertainVideoSnapshotInput = {
  protocol: "api" | "adobe_direct" | "unknown";
  hasBackendMember: boolean;
  hasAdapterIdentity: boolean;
  hasModelCapabilitySnapshot: boolean;
  hasValidInputManifest: boolean;
  hasStorageBucket: boolean;
  hasLedgerConsumption: boolean;
};

const acceptedTaskIdSchema = z.string().trim().min(1).max(1_024);
const MAX_FAILURE_REASON_CHARACTERS = 1_000;

const FAILURE_REASONS: Record<
  VideoSubmissionFailureCode,
  { user: string; operations: string }
> = {
  submission_timeout: {
    user: "生成服务请求超时，请稍后重试",
    operations: "上游视频创建请求超时",
  },
  network_error: {
    user: "生成服务网络异常，请稍后重试",
    operations: "上游视频创建网络连接失败",
  },
  response_read_failed: {
    user: "生成服务响应异常，请稍后重试",
    operations: "上游视频创建响应读取失败",
  },
  response_parse_failed: {
    user: "生成服务响应异常，请稍后重试",
    operations: "上游视频创建响应解析失败",
  },
  missing_upstream_task_id: {
    user: "生成服务响应异常，请稍后重试",
    operations: "上游视频创建响应缺少有效任务 ID 或同步产物",
  },
  rate_limited: {
    user: "生成服务繁忙，请稍后重试",
    operations: "上游视频创建请求被限流",
  },
  upstream_unavailable: {
    user: "生成服务暂时不可用，请稍后重试",
    operations: "上游视频创建服务暂时不可用",
  },
  authentication_failed: {
    user: "当前生成服务暂时不可用，请稍后重试",
    operations: "上游视频账号认证失败",
  },
  permission_denied: {
    user: "当前生成服务暂时不可用，请稍后重试",
    operations: "上游视频账号权限不足",
  },
  invalid_request: {
    user: "视频生成参数未被服务接受",
    operations: "上游视频创建拒绝请求参数",
  },
  moderation_rejected: {
    user: "视频生成请求未通过内容审核",
    operations: "上游视频创建请求被内容审核拒绝",
  },
  submission_conflict: {
    user: "生成服务未能确认任务创建",
    operations: "上游视频创建返回冲突但没有有效任务 ID",
  },
  capacity_wait_timeout: {
    user: "当前生成服务繁忙，请稍后重试",
    operations: "所有合格 API 账号容量等待超时",
  },
  no_eligible_api_account: {
    user: "当前没有可用生成服务",
    operations: "没有符合任务模型和能力要求的 API 账号",
  },
  unknown_submission_failure: {
    user: "视频生成失败，请稍后重试",
    operations: "上游视频创建发生未分类错误",
  },
};

/**
 * 生成带固定安全文案的失败结论。
 *
 * @param action 自动恢复动作。
 * @param failureCode 稳定低基数失败代码。
 * @returns 不含上游正文和凭据的分类结果。
 * @sideEffects 无。
 * @failure 不抛错；代码和值均由内部联合类型限制。
 */
function decision(
  action: Exclude<VideoSubmissionFailureAction, "accepted">,
  failureCode: VideoSubmissionFailureCode
): VideoSubmissionFailureDecision {
  const reasons = FAILURE_REASONS[failureCode];
  return {
    action,
    failureCode,
    userReason: reasons.user,
    operationsReason: reasons.operations,
  };
}

/**
 * 清洗可持久化的安全失败原因。
 *
 * @param value 已经是安全摘要但仍视为不可信的文本。
 * @returns 无控制字符、常见凭据且不超过 1000 字符的单行原因。
 * @sideEffects 无。
 * @failure 空值回退为固定通用原因，不抛错。
 */
export function sanitizeVideoSubmissionFailureReason(value: unknown): string {
  if (typeof value !== "string") return "视频生成失败，请稍后重试";
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  })
    .join("")
    .replace(/bearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[a-z0-9_-]+\b/giu, "[REDACTED]")
    .replace(
      /(authorization|api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;，；。]+/giu,
      "$1=[REDACTED]"
    )
    .replace(/\s+/gu, " ")
    .trim();
  const safe = normalized || "视频生成失败，请稍后重试";
  return safe.slice(0, MAX_FAILURE_REASON_CHARACTERS);
}

/**
 * 计算同账号下一次创建时间；上游提示只能延长基础等待且统一封顶 300 秒。
 *
 * @param input 当前系统设置、受控 Retry-After、失败时钟。
 * @returns 可直接持久化的延迟明细与下一次执行时间。
 * @sideEffects 无。
 * @failure 非法配置显式抛错，避免错误设置造成无界等待或抢跑。
 */
export function resolveVideoSubmissionRetrySchedule(input: {
  baseDelaySeconds: number;
  retryAfterSeconds?: number;
  now: Date;
}): VideoSubmissionRetrySchedule {
  if (
    !Number.isInteger(input.baseDelaySeconds) ||
    input.baseDelaySeconds < 0 ||
    input.baseDelaySeconds > 300
  ) {
    throw new Error("视频同账号重试等待配置无效");
  }
  const retryAfterSeconds =
    input.retryAfterSeconds === undefined
      ? undefined
      : Math.min(300, Math.max(0, Math.ceil(input.retryAfterSeconds)));
  const finalDelaySeconds = Math.max(
    input.baseDelaySeconds,
    retryAfterSeconds ?? 0
  );
  return {
    baseDelaySeconds: input.baseDelaySeconds,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    finalDelaySeconds,
    nextAttemptAt: new Date(input.now.getTime() + finalDelaySeconds * 1_000),
  };
}

/**
 * 识别升级前遗留 `submit_uncertain` 任务的安全迁移方向。
 *
 * @deprecated 仅用于 0087 前 API 人工态数据。下个版本在遗留查询为零后连同
 * `submit_uncertain` 兼容输入一起删除；Adobe direct 永远不进入本迁移。
 * @param input 从持久任务、账本和适配版本校验出的完整恢复事实。
 * @returns 自动重试、只退款的无效快照，或不适用。
 * @sideEffects 无；真实 CAS、退款与告警由 U3 状态机执行。
 * @failure 任一事实缺失均 fail closed 为只退款，不伪造恢复身份。
 */
export function classifyLegacyUncertainVideoSnapshot(
  input: LegacyUncertainVideoSnapshotInput
): "retrying" | "refund_invalid_snapshot" | "not_applicable" {
  if (input.protocol !== "api") return "not_applicable";
  return input.hasBackendMember &&
    input.hasAdapterIdentity &&
    input.hasModelCapabilitySnapshot &&
    input.hasValidInputManifest &&
    input.hasStorageBucket &&
    input.hasLedgerConsumption
    ? "retrying"
    : "refund_invalid_snapshot";
}

/**
 * 按固定优先级分类一次 API 视频创建结果。
 *
 * @param input 不含原始正文的传输、HTTP、脚本与接受事实。
 * @returns 已接受、同账号重试、当前任务切号或终止退款结论。
 * @sideEffects 无。
 * @failure 非法状态码和未知分类安全收敛为同账号重试的通用错误。
 */
export function classifyVideoSubmissionFailure(
  input: VideoSubmissionFailureInput
): VideoSubmissionFailureDecision {
  if (acceptedTaskIdSchema.safeParse(input.acceptedTaskId).success) {
    return { action: "accepted" };
  }

  if (input.scriptedCategory === "moderation") {
    return decision("terminate_and_refund", "moderation_rejected");
  }
  if (input.scriptedCategory === "invalid_request") {
    return decision("terminate_and_refund", "invalid_request");
  }
  if (
    input.statusCode === 409 &&
    input.scriptedRetryable === true &&
    ["capacity", "rate_limit", "timeout", "upstream", "unknown"].includes(
      input.scriptedCategory ?? "unknown"
    )
  ) {
    return decision("retry_same_member", "upstream_unavailable");
  }
  if (input.statusCode === 409) {
    return decision("terminate_and_refund", "submission_conflict");
  }
  if (input.statusCode === 401 || input.scriptedCategory === "authentication") {
    return decision("switch_member", "authentication_failed");
  }
  if (input.statusCode === 403 || input.scriptedCategory === "permission") {
    return decision("switch_member", "permission_denied");
  }
  if (input.statusCode === 429 || input.scriptedCategory === "rate_limit") {
    return decision("retry_same_member", "rate_limited");
  }
  if (input.statusCode === 408 || input.kind === "timeout") {
    return decision("retry_same_member", "submission_timeout");
  }
  if (input.kind === "network") {
    return decision("retry_same_member", "network_error");
  }
  if (input.kind === "response_read") {
    return decision("retry_same_member", "response_read_failed");
  }
  if (input.kind === "response_parse") {
    return decision("retry_same_member", "response_parse_failed");
  }
  if (input.kind === "missing_task_id") {
    return decision("retry_same_member", "missing_upstream_task_id");
  }
  if (
    (input.statusCode !== undefined && input.statusCode >= 500) ||
    ["capacity", "timeout", "upstream"].includes(
      input.scriptedCategory ?? "unknown"
    )
  ) {
    return decision("retry_same_member", "upstream_unavailable");
  }
  if (input.statusCode !== undefined && input.statusCode >= 400) {
    return decision("terminate_and_refund", "invalid_request");
  }
  return decision("retry_same_member", "unknown_submission_failure");
}
