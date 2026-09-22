/**
 * Next.js 服务进程启动钩子。
 *
 * 职责：设置 Go 代理地址并初始化 Sentry。调度器、设置初始化和媒体 Worker
 * 均由 Go 后端拥有，Next 进程不加载旧业务启动路径。
 */

/** 初始化当前 Next.js Runtime 所需的进程级服务。 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // A local Next process without an explicit environment file must still be
    // an adapter in the migrated deployment. Set the same default used by the
    // Go proxy before any worker/repository module can inspect the flag.
    if (!process.env.GO_BACKEND_URL && !process.env.GO_BACKEND_INTERNAL_URL) {
      process.env.GO_BACKEND_URL = "http://127.0.0.1:8080";
    }
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}
