/**
 * 数据库暂时不可用错误的跨传输识别。
 *
 * 使用方包括 UOL 调用方、Server Action 和 Dashboard Server Component。这里只识别
 * 稳定错误码与已脱敏异常特征，不返回 SQL、绑定参数或连接配置。
 */
import { OperationError } from "./uol/errors";
import { isPostgresTimeoutError } from "./postgres-timeout";

/** 判断未知值是否为可安全读取属性的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 判断 Better Auth 是否因会话查询失败而返回稳定 API 错误。
 *
 * Better Auth 会移除底层 Drizzle `cause`，因此只能依据其公开的错误码识别这个可重试
 * 查询失败；调用方仍应记录通用不可用事件，不能回传原始异常。
 */
export function isAuthSessionQueryUnavailableError(error: unknown): boolean {
  if (!isRecord(error) || !isRecord(error.body)) return false;
  return error.body.code === "FAILED_TO_GET_SESSION";
}

/**
 * 判断错误是否应映射为面向用户的数据库查询超时。
 *
 * 同时覆盖原始 PostgreSQL/Drizzle 异常，以及由 UOL 明确标记为 PostgreSQL 来源的
 * `timeout`。其他上游超时和 Better Auth 的通用会话失败不能归因为数据库超时。
 */
export function isDatabaseQueryTimeoutError(error: unknown): boolean {
  return (
    isPostgresTimeoutError(error) ||
    (error instanceof OperationError &&
      error.code === "timeout" &&
      error.details?.source === "postgres")
  );
}
