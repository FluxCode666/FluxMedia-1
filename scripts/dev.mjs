/**
 * 本地开发进程编排器。
 *
 * 使用方：根目录 `pnpm dev`。脚本启动 Turbo Web 开发服务，并确保退出时
 * 清理子进程组。
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const turboEntry = resolve(projectRoot, "node_modules/turbo/bin/turbo");
const supportsProcessGroups = process.platform !== "win32";
const children = new Map();
let shuttingDown = false;
let requestedExitCode = 0;
let forceKillTimer;

/**
 * 向子进程及其派生进程发送退出信号。
 *
 * @param child Node.js 创建的子进程。
 * @param signal 要发送的 POSIX 信号。
 * @returns 无返回值；目标已退出时静默结束。
 * @sideEffects 在 POSIX 系统终止整个独立进程组，防止残留代理或 Next 进程。
 */
function signalChildProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    if (supportsProcessGroups) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      console.error(`无法向子进程发送 ${signal}`, error);
    }
  }
}

/**
 * 在所有子进程关闭后确定主命令的最终退出码。
 *
 * @returns 无返回值；仍有子进程运行时保持等待。
 * @sideEffects 清理强制退出定时器并设置当前 Node.js 进程退出码。
 */
function finishWhenChildrenClose() {
  if (children.size > 0) return;
  if (forceKillTimer) clearTimeout(forceKillTimer);
  process.exitCode = requestedExitCode;
}

/**
 * 关闭仍在运行的本地开发进程。
 *
 * @param signal 首次发送给子进程的退出信号。
 * @param exitCode 主命令应返回的退出码。
 * @returns 无返回值；重复调用不会重新安排清理流程。
 * @sideEffects 先请求优雅退出，五秒后强制清理仍未关闭的进程组。
 */
function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  requestedExitCode = exitCode;
  for (const child of children.values()) {
    signalChildProcessTree(child, signal);
  }
  if (children.size === 0) {
    finishWhenChildrenClose();
    return;
  }
  forceKillTimer = setTimeout(() => {
    for (const child of children.values()) {
      signalChildProcessTree(child, "SIGKILL");
    }
  }, 5_000);
  forceKillTimer.unref();
}

/**
 * 启动并登记一个本地开发子进程。
 *
 * @param name 用于错误日志的可读名称。
 * @param command 可执行文件路径或命令名。
 * @param args 传递给可执行文件的参数。
 * @param cwd 子进程工作目录。
 * @param environment Web 与代理共享的环境变量。
 * @returns 已启动的子进程。
 * @sideEffects 继承终端输入输出，并在异常退出时关闭另一个开发进程。
 */
function startChild(name, command, args, cwd, environment) {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: "inherit",
    detached: supportsProcessGroups,
  });
  children.set(name, child);

  child.once("error", (error) => {
    console.error(`${name} 启动失败`, error);
  });
  child.once("close", (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`;
      console.error(`${name} 已退出（${reason}），正在关闭其他开发进程`);
      shutdown("SIGTERM", code && code > 0 ? code : 1);
    }
    finishWhenChildrenClose();
  });

  return child;
}

/**
 * 启动完整的本地开发链路并注册终端信号处理。
 *
 * @returns 无返回值；进程持续运行直到子进程退出或收到终端信号。
 * @sideEffects 启动 Turbo，并接管 SIGINT、SIGTERM 的清理流程。
 */
function runDevelopmentServices() {
  startChild(
    "Turbo Web 开发服务",
    process.execPath,
    [turboEntry, "dev", "--env-mode=loose"],
    projectRoot,
    process.env
  );

  process.once("SIGINT", () => shutdown("SIGINT", 130));
  process.once("SIGTERM", () => shutdown("SIGTERM", 143));
}

runDevelopmentServices();
