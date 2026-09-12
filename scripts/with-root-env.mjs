/**
 * 从仓库根目录加载 .env.local、.env 后启动子进程。
 *
 * 供根 package.json 及各工作区启动脚本复用，确保 pnpm 改变 cwd 时仍使用
 * 同一份本地运行配置。系统环境变量优先，其次 .env.local，再其次 .env。
 * 默认执行 Node.js 脚本；--exec 可执行 Go、pnpm 等命令，不经过 shell 拼接。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const argumentsToRun = process.argv.slice(2);
const executeDirectly = argumentsToRun[0] === "--exec";
if (executeDirectly) argumentsToRun.shift();
const [command, ...commandArguments] = argumentsToRun;

/**
 * 将根目录环境文件合并到当前进程环境变量中。
 *
 * @returns 环境文件缺失或成功加载时为 true；解析失败时为 false。
 * @sideEffects 仅填充当前进程中尚未定义的环境变量，不覆盖外部注入的配置。
 */
function loadRootEnvironment() {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(projectRoot, name);
    if (!existsSync(path)) continue;
    const result = dotenv.config({ path, quiet: true });
    if (result.error) {
      console.error(`无法加载项目根目录 ${name}`);
      return false;
    }
  }
  return true;
}

/**
 * 使用根目录环境变量执行传入的 Node.js 命令。
 *
 * @returns 无返回值；子进程退出码会透传给当前 pnpm 命令。
 * @sideEffects 启动子进程并继承其标准输入、输出和错误输出。
 * @throws 子进程无法创建时设置失败退出码并输出错误。
 */
function runCommand() {
  if (!loadRootEnvironment()) {
    process.exitCode = 1;
    return;
  }

  if (!command) {
    console.error("缺少要执行的命令");
    process.exitCode = 1;
    return;
  }

  const child = spawn(
    executeDirectly ? command : process.execPath,
    executeDirectly ? commandArguments : [command, ...commandArguments],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    }
  );

  child.once("error", (error) => {
    console.error("无法启动子进程", error);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

runCommand();
