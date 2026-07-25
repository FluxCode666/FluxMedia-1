/**
 * Dashboard 首屏错误的纯分类器。
 *
 * 使用方是 Dashboard 页面和公共布局。它只返回可安全展示的稳定状态，不携带原始 SQL、
 * 查询参数、会话信息或异常消息，便于 Server Component 做一致的降级处理。
 */
import {
  isAuthSessionQueryUnavailableError,
  isDatabaseQueryTimeoutError,
} from "@repo/shared/database-errors";
import { OperationError } from "@repo/shared/uol/errors";

export type DashboardLoadFailureReason =
  | "not_ready"
  | "query_timeout"
  | "query_unavailable";

/**
 * 将未知首屏异常归类为允许展示的 Dashboard 状态。
 *
 * @param error Server Component 捕获到的未知异常。
 * @returns 可安全展示的原因；无法确认时返回 null，调用方必须继续抛出。
 */
export function getDashboardLoadFailureReason(
  error: unknown
): DashboardLoadFailureReason | null {
  if (error instanceof OperationError && error.code === "not_ready") {
    return "not_ready";
  }
  if (isDatabaseQueryTimeoutError(error)) return "query_timeout";
  if (isAuthSessionQueryUnavailableError(error)) return "query_unavailable";
  return null;
}
