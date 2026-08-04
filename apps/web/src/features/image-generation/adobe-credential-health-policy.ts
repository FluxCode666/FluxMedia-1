/**
 * Adobe direct 成员凭据健康的纯策略。
 *
 * 职责：集中定义双 Profile 结果、失败归属、严格诊断 allowlist、5/15 分钟
 * 复检与第三次隔离状态机，以及提交前 claim/revision CAS 判定。使用方是健康评估
 * service、被动检查和后续 cron/UOL binding；本文件不访问数据库或网络。
 */
import {
  AdobeRequestError,
  AuthError,
  QuotaExhaustedError,
  UpstreamTemporaryError,
} from "@repo/shared/adobe/firefly-direct";

export const ADOBE_CREDENTIAL_PROFILES = ["express", "firefly"] as const;

export type AdobeCredentialProfile = (typeof ADOBE_CREDENTIAL_PROFILES)[number];

export type AdobeCredentialEvaluationSource =
  | "scheduled"
  | "passive"
  | "manual"
  | "reauthorization";

export type AdobeCredentialHealthStatus =
  | "pending"
  | "healthy"
  | "degraded"
  | "isolated"
  | "overdue";

export type AdobeCredentialFailureCategory =
  | "auth_rejected"
  | "identity_invalid"
  | "quota_exhausted"
  | "timeout"
  | "rate_limited"
  | "temporary_upstream"
  | "proxy_network"
  | "profile_invalid"
  | "proxy_not_configured"
  | "platform_failure";

export type AdobeCredentialDiagnostic = {
  statusCode?: number;
  adobeErrorCode?: string;
  message?: string;
  requestId?: string;
};

export type AdobeCredentialEvaluationOutcome = {
  kind: "success" | "member_failure" | "platform_failure";
  failureProfiles: AdobeCredentialProfile[];
  diagnostic: AdobeCredentialDiagnostic | null;
};

export type AdobeCredentialHealthState = {
  status: AdobeCredentialHealthStatus;
  consecutiveFailures: number;
  failureProfiles: AdobeCredentialProfile[];
  nextCheckAt: Date;
  lastCheckAt: Date | null;
  lastSuccessAt: Date | null;
  firstFailureAt: Date | null;
  lastFailureAt: Date | null;
  isolatedAt: Date | null;
  diagnostic: AdobeCredentialDiagnostic | null;
};

export type ClassifiedAdobeCredentialFailure = {
  kind: "member_failure" | "platform_failure";
  category: AdobeCredentialFailureCategory;
  diagnostic: AdobeCredentialDiagnostic | null;
};

const NORMAL_CHECK_DELAY_MINUTES = 45;
const FIRST_FAILURE_RECHECK_MINUTES = 5;
const SECOND_FAILURE_RECHECK_MINUTES = 15;
const ISOLATION_FAILURE_THRESHOLD = 3;

const SENSITIVE_DIAGNOSTIC_PATTERN =
  /(?:authorization|cookie|password|passcode|client[_-]?secret|proxy[_-]?secret|hmac[_-]?key|(?:access|refresh|id)[_-]?token|aux_sid)["']?\s*[:=]|(?:access|refresh|id)%5f?token(?:%22)?%3a|bearer\s+|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}|[A-Za-z0-9+/]{24,}={0,2}/i;
const SAFE_DIAGNOSTIC_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;

/**
 * 以 UTC 毫秒计算下一次检查时间。
 *
 * @param value 当前评估完成时间。
 * @param minutes 延迟分钟数。
 * @returns 新 Date；不修改输入对象且无失败分支。
 */
function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

/**
 * 把未知诊断字符串收敛为安全有限文本。
 *
 * @param value 外部错误字段。
 * @param maxLength 最大持久化字符数。
 * @param identifierOnly 是否只允许稳定标识符字符。
 * @returns 安全字符串；疑似凭据、空值或非法标识符返回 undefined。
 */
function sanitizeDiagnosticText(
  value: unknown,
  maxLength: number,
  identifierOnly = false
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maxLength);
  if (!normalized || SENSITIVE_DIAGNOSTIC_PATTERN.test(normalized)) {
    return undefined;
  }
  if (identifierOnly && !SAFE_DIAGNOSTIC_IDENTIFIER.test(normalized)) {
    return undefined;
  }
  return normalized;
}

/**
 * 从未知值读取一个直接属性，不遍历 cause、header 或嵌套 raw。
 *
 * @param value 未知错误或响应摘要。
 * @param names 可接受的直接属性名。
 * @returns 第一个存在的属性值；原始输入不是对象时返回 undefined。
 */
function readOwnField(value: unknown, names: readonly string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    if (Object.hasOwn(record, name)) return record[name];
  }
  return undefined;
}

/**
 * 严格清洗可持久化、可返回管理员页面的 Adobe 诊断。
 *
 * @param input Adobe 错误或已解析响应摘要。
 * @returns 只含 statusCode、adobeErrorCode、message、requestId 的新对象；若无
 * 安全字段则返回 null。函数不会序列化 Error cause、header、Cookie 或 Token。
 */
export function sanitizeAdobeCredentialDiagnostic(
  input: unknown
): AdobeCredentialDiagnostic | null {
  const directStatus = readOwnField(input, ["statusCode", "status"]);
  const statusCode =
    typeof directStatus === "number" &&
    Number.isInteger(directStatus) &&
    directStatus >= 100 &&
    directStatus <= 599
      ? directStatus
      : undefined;
  const adobeErrorCode = sanitizeDiagnosticText(
    readOwnField(input, ["adobeErrorCode", "errorCode", "errorType", "code"]),
    128,
    true
  );
  const message = sanitizeDiagnosticText(
    input instanceof Error ? input.message : readOwnField(input, ["message"]),
    512
  );
  const requestId = sanitizeDiagnosticText(
    readOwnField(input, ["requestId", "request_id"]),
    256,
    true
  );
  const result: AdobeCredentialDiagnostic = {};
  if (statusCode !== undefined) result.statusCode = statusCode;
  if (adobeErrorCode !== undefined) result.adobeErrorCode = adobeErrorCode;
  if (message !== undefined) result.message = message;
  if (requestId !== undefined) result.requestId = requestId;
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 从非结构化错误消息中提取 HTTP 状态，仅用于分类，不持久化原始消息。
 *
 * @param message Error.message。
 * @returns 100–599 的状态码，否则返回 undefined。
 */
function statusFromMessage(message: string): number | undefined {
  const match = message.match(/(?:http|status|failed)\D{0,12}([1-5]\d{2})/i);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return value >= 100 && value <= 599 ? value : undefined;
}

/**
 * 把 HTTP 状态映射为成员级失败类别。
 *
 * @param status Adobe 或代理返回的 HTTP 状态。
 * @returns 鉴权、限流或临时上游类别；普通状态返回 profile_invalid。
 */
function categoryFromStatus(status: number): AdobeCredentialFailureCategory {
  if (status === 401 || status === 403) return "auth_rejected";
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status === 451 || status >= 500) return "temporary_upstream";
  return "profile_invalid";
}

/**
 * 确定 Adobe 健康失败归属。
 *
 * @param error transport/auth 抛出的错误。
 * @param options 代理是否已完整配置；仅“未配置”属于平台故障，已配置代理的
 * 网络或转发失败按成员评估失败计数。
 * @returns 稳定分类和严格清洗诊断；不会返回原始 Error 或响应。
 */
export function classifyAdobeCredentialFailure(
  error: unknown,
  options: { proxyConfigured?: boolean } = {}
): ClassifiedAdobeCredentialFailure {
  const message = error instanceof Error ? error.message : "";
  const lowerMessage = message.toLowerCase();
  if (
    options.proxyConfigured === false ||
    /proxy.+(?:not configured|required)|需要配置.+proxy/i.test(message)
  ) {
    return {
      kind: "platform_failure",
      category: "proxy_not_configured",
      diagnostic: null,
    };
  }

  const directStatus =
    error instanceof AdobeRequestError ? error.statusCode : undefined;
  const status = directStatus ?? statusFromMessage(message);
  let category: AdobeCredentialFailureCategory;
  if (error instanceof AuthError) {
    category = "auth_rejected";
  } else if (error instanceof QuotaExhaustedError) {
    category = "quota_exhausted";
  } else if (
    /guestid|account.+mismatch|账号.+不一致|missing.+(?:account|user).+id/i.test(
      message
    )
  ) {
    category = "identity_invalid";
  } else if (
    error instanceof UpstreamTemporaryError &&
    ["proxy", "connection", "network"].includes(error.errorType)
  ) {
    category = "proxy_network";
  } else if (status !== undefined) {
    category = categoryFromStatus(status);
  } else if (error instanceof DOMException && error.name === "AbortError") {
    category = "timeout";
  } else if (/timeout|timed out|aborted/.test(lowerMessage)) {
    category = "timeout";
  } else if (/proxy|network|connection|socket|econn/.test(lowerMessage)) {
    category = "proxy_network";
  } else if (error instanceof UpstreamTemporaryError) {
    category = "temporary_upstream";
  } else if (/cookie|token|unauthorized|forbidden/.test(lowerMessage)) {
    category = "auth_rejected";
  } else {
    category = "profile_invalid";
  }

  const diagnostic = sanitizeAdobeCredentialDiagnostic(
    error instanceof AdobeRequestError && status !== undefined
      ? {
          statusCode: status,
          adobeErrorCode: error.adobeErrorCode || error.errorType || undefined,
          message: error.userMessage,
          requestId: error.requestId,
        }
      : status !== undefined
        ? { statusCode: status, message }
        : error
  );
  return { kind: "member_failure", category, diagnostic };
}

/**
 * 将一整轮双 Profile 结果收敛为成员健康摘要。
 *
 * @param input 当前状态、评估完成时间和整轮结果。
 * @returns 新状态；双 Profile 同时失败也只增加一次。平台故障原样返回当前状态；
 * 隔离成员的普通成功不会自动恢复。
 */
export function reduceAdobeCredentialHealth(input: {
  state: AdobeCredentialHealthState;
  now: Date;
  outcome: AdobeCredentialEvaluationOutcome;
}): AdobeCredentialHealthState {
  if (input.outcome.kind === "platform_failure") return { ...input.state };
  const completedAt = new Date(input.now);
  if (input.state.status === "isolated") {
    return {
      ...input.state,
      failureProfiles: [...input.outcome.failureProfiles],
      nextCheckAt: addMinutes(completedAt, NORMAL_CHECK_DELAY_MINUTES),
      lastCheckAt: completedAt,
      ...(input.outcome.kind === "member_failure"
        ? { lastFailureAt: completedAt }
        : { lastSuccessAt: completedAt }),
      diagnostic: input.outcome.diagnostic,
    };
  }
  if (input.outcome.kind === "success") {
    return {
      ...input.state,
      status: "healthy",
      consecutiveFailures: 0,
      failureProfiles: [],
      nextCheckAt: addMinutes(completedAt, NORMAL_CHECK_DELAY_MINUTES),
      lastCheckAt: completedAt,
      lastSuccessAt: completedAt,
      firstFailureAt: null,
      lastFailureAt: null,
      isolatedAt: null,
      diagnostic: input.outcome.diagnostic,
    };
  }

  const consecutiveFailures = input.state.consecutiveFailures + 1;
  const isolated = consecutiveFailures >= ISOLATION_FAILURE_THRESHOLD;
  const recheckMinutes =
    consecutiveFailures === 1
      ? FIRST_FAILURE_RECHECK_MINUTES
      : consecutiveFailures === 2
        ? SECOND_FAILURE_RECHECK_MINUTES
        : NORMAL_CHECK_DELAY_MINUTES;
  return {
    ...input.state,
    status: isolated ? "isolated" : "degraded",
    consecutiveFailures,
    failureProfiles: [...new Set(input.outcome.failureProfiles)],
    nextCheckAt: addMinutes(completedAt, recheckMinutes),
    lastCheckAt: completedAt,
    firstFailureAt: input.state.firstFailureAt ?? completedAt,
    lastFailureAt: completedAt,
    isolatedAt: isolated ? (input.state.isolatedAt ?? completedAt) : null,
    diagnostic: input.outcome.diagnostic,
  };
}

export type AdobeCredentialClaimCasResult =
  | { accepted: true; disposition: "accepted" }
  | {
      accepted: false;
      disposition: "stale" | "discarded";
      reason:
        | "claim_mismatch"
        | "claim_expired"
        | "credential_revision_mismatch"
        | "member_enable_revision_mismatch"
        | "member_disabled"
        | "not_direct";
    };

export type AdobeCredentialClaimResult =
  | {
      claimed: true;
      claimToken: string;
      claimExpiresAt: Date;
      credentialRevision: number;
      memberEnableRevision: number;
    }
  | {
      claimed: false;
      reason: "already_claimed" | "member_disabled" | "not_direct" | "not_due";
    };

/**
 * 纯函数判定一个成员能否取得新的评估 claim。
 *
 * @param input 锁内健康摘要、当前时间、调用方生成的稳定 token 与 TTL；scanner 可
 * 通过 requireDue 限制 nextCheckAt，手动/被动评估则忽略 due 时间。
 * @returns claim 快照或明确拒绝原因；超时 claim 可被新 claimant 覆盖。
 */
export function claimAdobeCredentialHealth(input: {
  current: {
    claimToken: string | null;
    claimExpiresAt: Date | null;
    credentialRevision: number;
    memberEnableRevision: number;
    isEnabled: boolean;
    isDirect: boolean;
    nextCheckAt: Date;
  };
  now: Date;
  claimToken: string;
  claimTtlMs: number;
  requireDue?: boolean;
}): AdobeCredentialClaimResult {
  if (!input.current.isEnabled) {
    return { claimed: false, reason: "member_disabled" };
  }
  if (!input.current.isDirect) {
    return { claimed: false, reason: "not_direct" };
  }
  if (
    input.current.claimToken &&
    input.current.claimExpiresAt &&
    input.current.claimExpiresAt.getTime() > input.now.getTime()
  ) {
    return { claimed: false, reason: "already_claimed" };
  }
  if (
    input.requireDue &&
    input.current.nextCheckAt.getTime() > input.now.getTime()
  ) {
    return { claimed: false, reason: "not_due" };
  }
  return {
    claimed: true,
    claimToken: input.claimToken,
    claimExpiresAt: new Date(input.now.getTime() + input.claimTtlMs),
    credentialRevision: input.current.credentialRevision,
    memberEnableRevision: input.current.memberEnableRevision,
  };
}

/**
 * 在数据库事务提交前判定 claim 与两个权威 revision 是否仍有效。
 *
 * @param input 当前锁内摘要和事务外评估开始时保存的快照。
 * @returns accepted 表示允许执行 CAS 更新；旧 claimant 返回 stale，凭据变更、
 * 启停变化或已离开 direct 返回 discarded。调用方只为拒绝结果追加有限历史。
 */
export function acceptAdobeCredentialClaim(input: {
  current: {
    claimToken: string | null;
    claimExpiresAt?: Date | null;
    credentialRevision: number;
    memberEnableRevision: number;
    isEnabled: boolean;
    isDirect?: boolean;
  };
  expected: {
    claimToken: string;
    credentialRevision: number;
    memberEnableRevision: number;
    completedAt?: Date;
  };
}): AdobeCredentialClaimCasResult {
  if (input.current.credentialRevision !== input.expected.credentialRevision) {
    return {
      accepted: false,
      disposition: "discarded",
      reason: "credential_revision_mismatch",
    };
  }
  if (
    input.current.memberEnableRevision !== input.expected.memberEnableRevision
  ) {
    return {
      accepted: false,
      disposition: "discarded",
      reason: "member_enable_revision_mismatch",
    };
  }
  if (!input.current.isEnabled) {
    return {
      accepted: false,
      disposition: "discarded",
      reason: "member_disabled",
    };
  }
  if (input.current.isDirect === false) {
    return {
      accepted: false,
      disposition: "discarded",
      reason: "not_direct",
    };
  }
  if (input.current.claimToken !== input.expected.claimToken) {
    return {
      accepted: false,
      disposition: "stale",
      reason: "claim_mismatch",
    };
  }
  if (
    input.current.claimExpiresAt &&
    input.expected.completedAt &&
    input.current.claimExpiresAt.getTime() <
      input.expected.completedAt.getTime()
  ) {
    return {
      accepted: false,
      disposition: "stale",
      reason: "claim_expired",
    };
  }
  return { accepted: true, disposition: "accepted" };
}
