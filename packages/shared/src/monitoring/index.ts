/**
 * 错误监控模块
 *
 * 配置 NEXT_PUBLIC_SENTRY_DSN 时按需加载 @sentry/react 上报浏览器错误；
 * 未配置时只打印到 console，不加载 Sentry 代码。
 */

type SentryModule = typeof import("@sentry/react");
type SeverityLevel = "fatal" | "error" | "warning" | "log" | "info" | "debug";

let sentry: Promise<SentryModule> | null = null;

/**
 * 检查 Sentry 是否已配置
 */
export function isSentryEnabled(): boolean {
  return !!process.env.NEXT_PUBLIC_SENTRY_DSN;
}

/** 首次调用时加载并初始化 Sentry；未配置时返回 null。 */
function loadSentry(): Promise<SentryModule> | null {
  if (!isSentryEnabled()) return null;
  sentry ??= import("@sentry/react").then((module) => {
    module.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0,
      ignoreErrors: ["Network request failed", "Failed to fetch", "Script error", "ResizeObserver loop"],
    });
    return module;
  });
  return sentry;
}

/**
 * 初始化浏览器错误监控；应用启动时调用。
 */
export function initSentryClient(): void {
  void loadSentry();
}

/**
 * 捕获异常
 *
 * @example
 * ```ts
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   captureError(error, { action: "checkout" });
 * }
 * ```
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  const loaded = loadSentry();
  if (!loaded) {
    console.error("[Error]", error, context);
    return;
  }
  void loaded.then((module) =>
    context ? module.captureException(error, { extra: context }) : module.captureException(error)
  );
}

/**
 * 捕获消息（非错误事件）
 */
export function captureMessage(
  message: string,
  level: SeverityLevel = "info",
  context?: Record<string, unknown>
): void {
  const loaded = loadSentry();
  if (!loaded) {
    const logFn = level === "error" ? console.error : level === "warning" ? console.warn : console.log;
    logFn(`[${level}]`, message, context);
    return;
  }
  void loaded.then((module) =>
    context ? module.captureMessage(message, { level, extra: context }) : module.captureMessage(message, level)
  );
}

/**
 * 设置用户上下文；传 null 清除（登出时）。
 */
export function setUser(user: { id: string; email?: string; username?: string } | null): void {
  void loadSentry()?.then((module) => module.setUser(user));
}
