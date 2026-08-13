/**
 * 运营总览 Server Action 的客户端安全结果类型与错误映射。
 *
 * 使用方：`actions.ts`、页面状态机和客户端面板。纯同步映射必须位于非
 * `"use server"` 模块，否则 Next.js 会把它误判为非法 Server Action 导出。
 */
import { OperationError } from "@repo/shared/uol";

/** 客户端可区分但不包含内部异常详情的稳定失败码。 */
export type OperationsDashboardActionFailure =
  | "validation_error"
  | "not_ready"
  | "rate_limited"
  | "timeout"
  | "unavailable";

/**
 * 将 UOL 异常转换为页面可显示的安全失败码。
 *
 * @param error UOL 或未知运行时异常。
 * @returns 白名单内失败码；未知错误统一降级为 unavailable。
 */
export function mapOperationsActionError(
  error: unknown
): OperationsDashboardActionFailure {
  if (!(error instanceof OperationError)) return "unavailable";
  switch (error.code) {
    case "validation_error":
    case "not_ready":
    case "rate_limited":
    case "timeout":
      return error.code;
    default:
      return "unavailable";
  }
}
