/**
 * Next.js 服务进程启动钩子。
 *
 * 职责：在 Node Runtime 接受请求前校验必需依赖和部署配置，建立进程级调度器与
 * API 上游脚本 Worker Pool；Edge Runtime 只初始化对应的 Sentry 配置。
 */

/** 初始化当前 Next.js Runtime 所需的进程级服务。 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureApiUpstreamScriptPool } = await import(
      "./features/image-backend-pool/api-upstream-script-pool"
    );
    await ensureApiUpstreamScriptPool();
    const { installApiUpstreamScriptShutdownHooks } = await import(
      "./features/image-backend-pool/api-upstream-script-lifecycle"
    );
    installApiUpstreamScriptShutdownHooks();
    const { ensureRequiredRedisReady } = await import(
      "@repo/shared/redis/required-client"
    );
    await ensureRequiredRedisReady();
    const { bootstrapSystemSettingsEnv } = await import(
      "@repo/shared/system-settings/bootstrap"
    );
    await bootstrapSystemSettingsEnv();
    const { bootstrapSelfUseSuperAdmin } = await import(
      "@repo/shared/auth/bootstrap-super-admin"
    );
    await bootstrapSelfUseSuperAdmin();
    const { startMediaTaskWorkers } = await import(
      "./server/media-task-workers"
    );
    await startMediaTaskWorkers();
    const { startInternalJobScheduler } = await import(
      "./server/internal-job-scheduler"
    );
    await startInternalJobScheduler();
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}
