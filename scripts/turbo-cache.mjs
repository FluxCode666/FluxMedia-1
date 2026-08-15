/**
 * Turbo 本地缓存容量守卫。
 *
 * 使用方：根目录 `cache:clean`、`cache:trim` 与高频质量命令。trim 默认在
 * 缓存超过 20 GiB 时清理，可用 `TURBO_CACHE_MAX_GIB` 调整；clean 明确
 * 清理。两者都会避开正在读写缓存的 Turbo 进程，并通过幂等的强制删除
 * 让并发维护收敛到同一结果。
 */
import { execFile } from "node:child_process";
import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const DEFAULT_MAX_CACHE_BYTES = 20 * 1024 ** 3;

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");

/**
 * Turbo 活动时抛出的可识别错误，供自动 trim 安全跳过。
 */
export class TurboProcessActiveError extends Error {
  /** 创建带稳定名称和用户提示的活动进程错误。 */
  constructor() {
    super("检测到正在读写缓存的 Turbo 任务，已取消缓存清理");
    this.name = "TurboProcessActiveError";
  }
}

/**
 * 判断异常是否带有指定的 Node.js 错误码。
 *
 * @param {unknown} error 待检查异常。
 * @param {string} code 预期错误码。
 * @returns {boolean} 错误码相同时为 true。
 */
function hasErrorCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/**
 * 将外部容量配置解析成安全的字节阈值。
 *
 * @param {string | undefined} rawValue GiB 数值；缺失时使用默认上限。
 * @returns {number} 可安全表示的正整数字节数。
 * @throws 配置不是正数或无法精确换算时抛出 TypeError。
 */
export function parseMaxCacheBytes(rawValue) {
  if (rawValue === undefined) return DEFAULT_MAX_CACHE_BYTES;
  const maxBytes = Number(rawValue) * 1024 ** 3;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(
      "TURBO_CACHE_MAX_GIB 必须是可精确换算为字节的大于 0 的数字"
    );
  }
  return maxBytes;
}

/**
 * 递归统计目录内文件的逻辑字节数，不跟随符号链接。
 *
 * @param {string} directoryPath 目标目录绝对路径。
 * @returns {Promise<number>} 文件大小之和；目录不存在时为 0。
 * @throws 无法读取目录或文件元数据时透传异常。
 */
export async function calculateDirectorySize(directoryPath) {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return 0;
    throw error;
  }

  let sizeBytes = 0;
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      sizeBytes += await calculateDirectorySize(entryPath);
      continue;
    }
    try {
      sizeBytes += (await lstat(entryPath)).size;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
  }
  return sizeBytes;
}

/**
 * 从带引号或绝对路径的命令参数中提取小写可执行文件名。
 *
 * @param {string | undefined} token 命令参数。
 * @returns {string | undefined} 去除路径和引号后的文件名。
 */
function getExecutableName(token) {
  if (token === undefined) return undefined;
  const unquotedToken = token.replace(/^["']|["']$/gu, "");
  return unquotedToken.split(/[\\/]/u).at(-1)?.toLowerCase();
}

/**
 * 判断命令行是否包含独立的 Turbo 可执行文件名。
 *
 * @param {string} commandLine 系统进程命令行。
 * @returns {boolean} Turbo CLI 命令为 true，相似脚本名不会误命中。
 */
export function isTurboCommand(commandLine) {
  const tokens = commandLine.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  const executableName = getExecutableName(tokens[0]);
  const scriptName = getExecutableName(tokens[1]);
  if (executableName === "turbo" || executableName === "turbo.exe") {
    return true;
  }
  const usesNode = executableName === "node" || executableName === "node.exe";
  return usesNode && (scriptName === "turbo" || scriptName === "turbo.exe");
}

/**
 * 判断 Turbo 命令是否会读写本项目缓存。
 *
 * `turbo.json` 已明确关闭 dev 任务缓存，因此开发服务器不阻止容量整理；
 * 其他 Turbo 命令均保守视为可能访问缓存。
 *
 * @param {string} commandLine 系统进程命令行。
 * @returns {boolean} 非 dev Turbo CLI 命令为 true。
 */
export function isTurboCacheWriter(commandLine) {
  const tokens = commandLine.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  const executableName = getExecutableName(tokens[0]);
  const turboIndex =
    executableName === "turbo" || executableName === "turbo.exe" ? 0 : 1;
  if (!isTurboCommand(commandLine)) return false;

  const firstArgument = tokens[turboIndex + 1]?.toLowerCase();
  const taskName =
    firstArgument === "run"
      ? tokens[turboIndex + 2]?.toLowerCase()
      : firstArgument;
  return taskName !== "dev";
}

/**
 * 跨平台枚举进程并检测正在读写缓存的 Turbo CLI。
 *
 * @returns {Promise<boolean>} 检测到非 dev Turbo 命令时为 true。
 * @throws 无法枚举进程时透传异常，清理流程据此失败关闭。
 */
export async function detectActiveTurboProcess() {
  const result =
    process.platform === "win32"
      ? await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { Write-Output ($_.ProcessId.ToString() + [char]9 + $_.CommandLine) }",
        ])
      : await execFileAsync("ps", ["-ax", "-o", "pid=", "-o", "command="]);

  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (
      match !== null &&
      Number.parseInt(match[1], 10) !== process.pid &&
      isTurboCacheWriter(match[2])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 幂等删除缓存目录，并容忍并发维护已先行删除目标。
 *
 * @param {string} cachePath 固定的 `.turbo/cache` 绝对路径。
 * @returns {Promise<void>} 目录不存在或清理完成时正常返回。
 * @throws 递归删除失败时透传文件系统异常。
 */
async function removeCacheDirectory(cachePath) {
  await rm(cachePath, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 100,
  });
}

/**
 * 按显式清理或容量阈值策略维护 Turbo 缓存。
 *
 * @param {{
 *   action: "clean" | "trim";
 *   projectRoot: string;
 *   maxBytes?: number;
 *   isTurboRunning?: () => Promise<boolean>;
 * }} options 操作、仓库路径、阈值及可测试的进程探测器。
 * @returns {Promise<{
 *   status: "cleaned" | "retained";
 *   previousSizeBytes: number;
 * }>} 维护状态和执行前大小。
 * @throws 参数非法、Turbo 活动或文件系统失败时抛出。
 */
export async function maintainTurboCache(options) {
  const {
    action,
    projectRoot: targetRoot,
    maxBytes = DEFAULT_MAX_CACHE_BYTES,
    isTurboRunning = detectActiveTurboProcess,
  } = options;
  if (action !== "clean" && action !== "trim") {
    throw new TypeError(`不支持的缓存维护操作：${action}`);
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Turbo 缓存上限必须是大于 0 的有限字节数");
  }
  if (await isTurboRunning()) throw new TurboProcessActiveError();

  const cachePath = resolve(targetRoot, ".turbo", "cache");
  const previousSizeBytes = await calculateDirectorySize(cachePath);
  if (action === "trim" && previousSizeBytes <= maxBytes) {
    return { previousSizeBytes, status: "retained" };
  }

  // 扫描可能较慢，删除前再次检查以缩短 Turbo 后启动造成的竞态窗口。
  if (await isTurboRunning()) throw new TurboProcessActiveError();
  await removeCacheDirectory(cachePath);
  return { previousSizeBytes, status: "cleaned" };
}

/**
 * 将字节数格式化为最多两位小数的 GiB 文本。
 *
 * @param {number} sizeBytes 字节数。
 * @returns {string} 终端可读的 GiB 数值。
 */
function formatGibibytes(sizeBytes) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 2,
  }).format(sizeBytes / 1024 ** 3);
}

/**
 * 解析动作并执行缓存维护；自动 trim 遇到活动 Turbo 时安全跳过。
 *
 * @returns {Promise<void>} 无返回值；显式 clean 或其他错误设置非零退出码。
 * @sideEffects 可能删除 `.turbo/cache` 并写终端输出。
 */
async function runCommand() {
  const action = process.argv[2];
  if (action !== "clean" && action !== "trim") {
    console.error("用法：node scripts/turbo-cache.mjs <clean|trim>");
    process.exitCode = 1;
    return;
  }

  try {
    const maxBytes = parseMaxCacheBytes(process.env.TURBO_CACHE_MAX_GIB);
    const result = await maintainTurboCache({
      action,
      maxBytes,
      projectRoot,
    });
    const size = formatGibibytes(result.previousSizeBytes);
    console.log(
      result.status === "cleaned"
        ? `已清理 ${size} GiB 的 Turbo 本地缓存`
        : `Turbo 缓存为 ${size} GiB，未超过 ${formatGibibytes(maxBytes)} GiB，已保留`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (action === "trim" && error instanceof TurboProcessActiveError) {
      console.log(`已跳过 Turbo 缓存整理：${message}`);
      return;
    }
    console.error(`Turbo 缓存维护失败：${message}`);
    process.exitCode = 1;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) await runCommand();
