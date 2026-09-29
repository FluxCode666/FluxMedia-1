/**
 * 日志模块
 *
 * 前端日志统一走浏览器 console，保留原结构化调用方式（对象 + 消息）。
 * 服务端日志由 Go backend 与各 Node runtime 自行输出，不再经过这里。
 */

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFn = {
  (message: string): void;
  (data: Record<string, unknown> | undefined, message?: string): void;
};

export type Logger = {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child: (context: Record<string, unknown>) => Logger;
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 生产环境只输出 warn 及以上，避免在用户控制台刷屏。 */
const minimumLevel: LogLevel = process.env.NODE_ENV === "production" ? "warn" : "debug";

const REDACTED_KEYS = new Set(["password", "token", "apikey", "secret", "authorization", "cookie", "sign"]);

/** 纵深防御：即便误传敏感字段，也在日志层做脱敏。 */
function redact(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 3) return value;
  if (value instanceof Error) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      REDACTED_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redact(item, depth + 1),
    ])
  );
}

function createLogger(context: Record<string, unknown>): Logger {
  const write =
    (level: LogLevel): LogFn =>
    (first: string | Record<string, unknown> | undefined, message?: string) => {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel]) return;
      const data = typeof first === "string" ? undefined : first;
      const text = typeof first === "string" ? first : (message ?? "");
      const payload = redact({ ...context, ...data });
      const hasPayload = Object.keys(payload as Record<string, unknown>).length > 0;
      if (hasPayload) console[level](text, payload);
      else console[level](text);
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (childContext) => createLogger({ ...context, ...childContext }),
  };
}

/**
 * 全局 Logger 实例
 */
export const logger = createLogger({});

/**
 * 创建带上下文的子 Logger
 *
 * @example
 * ```ts
 * const log = createContextLogger({ userId: "123" });
 * log.info("User action");
 * ```
 */
export function createContextLogger(context: Record<string, unknown>): Logger {
  return logger.child(context);
}

/**
 * 业务事件类型
 */
export type BusinessEvent =
  | "user.signup"
  | "user.login"
  | "user.logout"
  | "payment.checkout.started"
  | "payment.checkout.completed"
  | "credits.purchased"
  | "credits.top_up.checkout_created"
  | "credits.top_up.fulfilled"
  | "credits.consumed"
  | "credits.expired"
  | "ticket.created"
  | "ticket.replied"
  | "ticket.closed"
  | "email.sent"
  | "file.uploaded"
  | "file.deleted"
  | "admin.user.banned"
  | "admin.user.unbanned";

/**
 * 记录业务事件
 */
export function logEvent(event: BusinessEvent, data?: Record<string, unknown>): void {
  logger.info({ event, ...data }, `Event: ${event}`);
}

/**
 * 记录错误（带堆栈）
 *
 * @example
 * ```ts
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   logError(error, { context: "payment processing" });
 * }
 * ```
 */
export function logError(error: unknown, context?: Record<string, unknown>): void {
  if (error instanceof Error) {
    logger.error({ err: error, ...context }, error.message);
  } else {
    logger.error({ err: error, ...context }, "Unknown error");
  }
}

/**
 * 记录警告
 */
export function logWarn(message: string, data?: Record<string, unknown>): void {
  logger.warn(data, message);
}

/**
 * 记录调试信息（仅开发环境）
 */
export function logDebug(message: string, data?: Record<string, unknown>): void {
  logger.debug(data, message);
}
