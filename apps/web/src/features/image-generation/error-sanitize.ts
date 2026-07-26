/**
 * 生成管线错误脱敏（DB-free，可单测）。
 *
 * 职责：把异常转成"可安全回传给前端"的 message。数据库/内部异常（如 Drizzle 池查询
 * 失败、Postgres 故障）及上游供应商响应绝不能把裸 SQL、列名、连接细节、访问令牌或
 * 上游地址暴露到 HTTP/SSE——只记录固定诊断事件并回通用可重试消息；已知用户级
 * 错误（积分不足、无可用后端等）保留原 message。
 *
 * 背景：issue #35「图生图报错」——图像后端池成员选择查询瞬时失败,Drizzle 的
 * "Failed query: select ... params: ..."（含 api_key 等列名）经兜底 catch 原样回传,
 * 直接显示在用户的「生成失败」toast 里。本模块在管线兜底处拦截这类内部错误。
 *
 * 使用方：image-generation/operations.ts 的兜底 catch。
 */

import { logError } from "@repo/shared/logger";

/** 从 Error 或既有结果对象中提取可检查的错误文案。 */
function getErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : null;
}

/**
 * 是否数据库/内部异常（不应把细节暴露给终端用户）。
 * 判据：
 * - Drizzle 把查询错误包成 message 形如 "Failed query: <sql>\nparams: ..."。
 * - node-postgres 原始错误带 5 位 SQLSTATE `code` 或 `severity`。
 * 反例：已知用户级错误（如 "Insufficient credits"、"分组无可用后端"）是普通 Error,
 * 无上述特征 → 返回 false → 原样透传。
 */
export function isInternalDatabaseError(error: unknown): boolean {
  const message = getErrorMessage(error);
  if (message && /^Failed query:/i.test(message)) return true;
  const candidate =
    error && typeof error === "object"
      ? (error as { code?: unknown; severity?: unknown })
      : {};
  if (
    typeof candidate.code === "string" &&
    /^[0-9A-Z]{5}$/.test(candidate.code)
  ) {
    return true;
  }
  if (typeof candidate.severity === "string") return true;
  return false;
}

/**
 * 是否可能携带供应商实现、网络拓扑或凭据细节的上游错误。
 *
 * 生成管线会把部分上游失败作为 `result.error` 正常返回而非抛异常，故同时接受
 * Error 与 string。只匹配供应商/网络/凭据边界信号，避免把积分、套餐、校验等面向
 * 用户的本地错误误降级。
 */
export function isSensitiveUpstreamError(error: unknown): boolean {
  const message = getErrorMessage(error);
  if (!message) return false;

  return /(?:\bupstream\b|\bimages\s+api\b|\badobe(?:\s+firefly)?\b|\bopenai\b|\b(?:api[_ -]?key|access[_ -]?token|authorization|bearer|cookie|set-cookie)\b|https?:\/\/|\b(?:econn(?:reset|refused)|enotfound|fetch failed|socket hang up|certificate|tls handshake)\b)/i.test(
    message
  );
}

/**
 * 把异常转成回传给前端的 message：
 * - 内部/DB 异常 → 只记固定 Pino 诊断事件（含 source/generationId）+ 回 fallback;
 * - 上游敏感异常 → 只记录稳定诊断事件，避免错误体再进入日志；
 * - 其余 → 用 Error/string message（其余类型用 fallback）。
 */
export function toClientErrorMessage(
  error: unknown,
  context: { source: string; generationId?: string },
  fallback: string
): string {
  if (isInternalDatabaseError(error)) {
    // Drizzle 会把 SQL 与 params 拼进 Error.message；params 可能包含用户凭据，
    // 因此日志也不能保留原始异常，只留下可关联的稳定事件和请求上下文。
    logError(
      new Error(
        "Image generation database failure redacted before client response"
      ),
      {
        source: context.source,
        ...(context.generationId ? { generationId: context.generationId } : {}),
      }
    );
    return fallback;
  }

  if (isSensitiveUpstreamError(error)) {
    // 上游正文有时回显 API key、账户 token 或内部网关 URL；日志仅保留可关联的
    // 生成 ID 与来源，不能为了诊断而把原始错误再次持久化。
    logError(
      new Error("Image provider failure redacted before client response"),
      {
        source: context.source,
        ...(context.generationId ? { generationId: context.generationId } : {}),
      }
    );
    return fallback;
  }

  return getErrorMessage(error) || fallback;
}
