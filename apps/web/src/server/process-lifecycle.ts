/**
 * Node 进程内服务生命周期协调器。
 *
 * 职责：为 Redis Worker、调度器和脚本池提供唯一 SIGTERM/SIGINT 入口，按优先级执行
 * 有界关闭，避免多个模块各自重新发送信号导致任务尚未恢复就被截断。
 */

type ShutdownHandler = () => Promise<void> | void;

type ProcessLifecycleState = {
  installed: boolean;
  shuttingDown: boolean;
  handlers: Map<string, { priority: number; handler: ShutdownHandler }>;
};

type ProcessLifecycleGlobal = typeof globalThis & {
  __fluxmediaProcessLifecycle?: ProcessLifecycleState;
};

const SHUTDOWN_TIMEOUT_MS = 25_000;

/** 获取热重载期间跨模块共享的生命周期状态。 */
function getLifecycleState(): ProcessLifecycleState {
  const runtimeGlobal = globalThis as ProcessLifecycleGlobal;
  if (!runtimeGlobal.__fluxmediaProcessLifecycle) {
    runtimeGlobal.__fluxmediaProcessLifecycle = {
      installed: false,
      shuttingDown: false,
      handlers: new Map(),
    };
  }
  return runtimeGlobal.__fluxmediaProcessLifecycle;
}

/**
 * 执行全部关闭处理并在固定窗口后恢复默认信号语义。
 *
 * @param signal 原始终止信号。
 * @returns 所有处理结束或超时后不返回；最终重新发送原信号。
 */
async function shutdownProcess(signal: NodeJS.Signals): Promise<void> {
  const state = getLifecycleState();
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  const handlers = [...state.handlers.values()].sort(
    (left, right) => left.priority - right.priority
  );
  const closeAll = Promise.allSettled(
    handlers.map(({ handler }) => Promise.resolve().then(handler))
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closeAll,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    process.kill(process.pid, signal);
  }
}

/** 注册唯一进程关闭处理；重复名称替换旧处理并保持顺序可审计。 */
export function registerProcessShutdownHook(
  name: string,
  handler: ShutdownHandler,
  priority = 100
): void {
  const state = getLifecycleState();
  state.handlers.set(name, { priority, handler });
  if (state.installed) return;
  state.installed = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdownProcess(signal);
    });
  }
}
