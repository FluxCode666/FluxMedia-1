/**
 * API 上游脚本 Worker Pool 的 Node 进程退出协调。
 *
 * 职责：仅在 Node Runtime 注册一次信号处理，先停止 Pool 准入和结算已预留响应，
 * 再恢复默认信号终止；单独成文件避免 Edge instrumentation 静态分析 Node API。
 */
import { shutdownApiUpstreamScriptPool } from "./api-upstream-script-pool";

type LifecycleGlobal = typeof globalThis & {
  __fluxmediaApiUpstreamScriptShutdownHooksInstalled?: boolean;
};

/** 注册一次 SIGTERM/SIGINT 钩子，并在结算结束后交还默认终止语义。 */
export function installApiUpstreamScriptShutdownHooks(): void {
  const lifecycleGlobal = globalThis as LifecycleGlobal;
  if (lifecycleGlobal.__fluxmediaApiUpstreamScriptShutdownHooksInstalled) {
    return;
  }
  lifecycleGlobal.__fluxmediaApiUpstreamScriptShutdownHooksInstalled = true;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdownApiUpstreamScriptPool().finally(() => {
        process.kill(process.pid, signal);
      });
    });
  }
}
