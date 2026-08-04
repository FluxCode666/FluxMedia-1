/**
 * Adobe Direct 凭据健康状态的共享纯模型。
 *
 * 职责：集中声明账号池可展示、筛选的凭据健康状态，并根据持久摘要计算当前
 * 生效状态。使用方是成员批量快照与单账号健康详情；不访问数据库或浏览器。
 */

/** Adobe Direct 凭据健康状态机的稳定状态集合。 */
export const ADOBE_CREDENTIAL_HEALTH_STATUSES = [
  "pending",
  "healthy",
  "degraded",
  "isolated",
  "overdue",
] as const;

/** Adobe Direct 凭据健康状态。 */
export type AdobeCredentialHealthStatus =
  (typeof ADOBE_CREDENTIAL_HEALTH_STATUSES)[number];

/** 计算当前生效状态所需的最小脱敏健康摘要。 */
export interface AdobeCredentialHealthStatusSnapshot {
  status: AdobeCredentialHealthStatus;
  failureProfiles: readonly ("express" | "firefly")[];
  lastCheckedAt: Date | string | null;
  lastSuccessAt: Date | string | null;
  nextCheckAt: Date | string | null;
}

const HEALTH_CHECK_COMPLETION_GRACE_MS = 5 * 60_000;

/**
 * 根据检查事实计算管理员当前应看到的凭据健康状态。
 *
 * @param health 持久化的最小健康摘要。
 * @param now 管理员查看时间，默认当前时间。
 * @returns 隔离优先；摘要不完整时降级；超过检查窗口五分钟时返回 overdue。
 * @sideEffects 无。
 * @failure 非法下次检查时间按 overdue 处理，不抛异常。
 */
export function getEffectiveAdobeCredentialHealthStatus(
  health: AdobeCredentialHealthStatusSnapshot,
  now = new Date()
): AdobeCredentialHealthStatus {
  if (health.status === "isolated") return health.status;
  if (
    health.status === "healthy" &&
    (!health.lastCheckedAt ||
      !health.lastSuccessAt ||
      health.failureProfiles.length > 0)
  ) {
    return health.failureProfiles.length > 0 ? "degraded" : "pending";
  }
  if (!health.nextCheckAt) return health.status;
  const nextCheckAt = new Date(health.nextCheckAt);
  if (Number.isNaN(nextCheckAt.getTime())) return "overdue";
  return now.getTime() >
    nextCheckAt.getTime() + HEALTH_CHECK_COMPLETION_GRACE_MS
    ? "overdue"
    : health.status;
}
