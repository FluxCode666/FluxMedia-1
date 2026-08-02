/**
 * API 上游脚本 Worker Pool 的进程级运行配置。
 *
 * 职责：只从部署环境解析 Worker 数、QuickJS 内存与栈限制，并在服务启动阶段
 * 对非法值失败关闭。账号配置和脚本均不能覆盖这些边界。
 */

/** Worker Pool 的部署环境变量。 */
export const API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS = {
  workerCount: "API_UPSTREAM_SCRIPT_WORKER_COUNT",
  memoryLimitMb: "API_UPSTREAM_SCRIPT_MEMORY_LIMIT_MB",
  stackLimitKb: "API_UPSTREAM_SCRIPT_STACK_LIMIT_KB",
} as const;

/** 不可变的 API 上游脚本运行配置。 */
export interface ApiUpstreamScriptRuntimeConfig {
  readonly workerCount: number;
  readonly memoryLimitBytes: number;
  readonly stackLimitBytes: number;
}

const DEFAULT_WORKER_COUNT = 1;
const DEFAULT_MEMORY_LIMIT_MB = 32;
const DEFAULT_STACK_LIMIT_KB = 512;
const MIN_WORKER_COUNT = 1;
const MAX_WORKER_COUNT = 8;
const MIN_MEMORY_LIMIT_MB = 16;
const MAX_MEMORY_LIMIT_MB = 128;
const MIN_STACK_LIMIT_KB = 256;
const MAX_STACK_LIMIT_KB = 2_048;

/**
 * 解析一个严格十进制整数环境变量。
 *
 * @param rawValue - 环境变量原值；undefined 使用默认值，空白或非整数均拒绝。
 * @param name - 用于启动错误定位的环境变量名。
 * @param fallback - 未配置时的安全默认值。
 * @param minimum - 允许的闭区间下界。
 * @param maximum - 允许的闭区间上界。
 * @returns 已验证的整数。
 * @throws RangeError 配置存在但格式非法或越界时抛出，不静默回退。
 */
function parseBoundedInteger(
  rawValue: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (rawValue === undefined) return fallback;
  if (!/^[0-9]+$/.test(rawValue)) {
    throw new RangeError(`${name} 必须是 ${minimum}-${maximum} 的整数`);
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return parsed;
}

/**
 * 从部署环境构造冻结的进程运行配置。
 *
 * @param environment - 默认读取 process.env；测试可传入无副作用的字典。
 * @returns 以字节表达资源限制的只读配置。
 * @throws RangeError 任意已配置值非法时阻止 Worker Pool 启动。
 */
export function parseApiUpstreamScriptRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Readonly<ApiUpstreamScriptRuntimeConfig> {
  const workerCount = parseBoundedInteger(
    environment[API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.workerCount],
    API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.workerCount,
    DEFAULT_WORKER_COUNT,
    MIN_WORKER_COUNT,
    MAX_WORKER_COUNT
  );
  const memoryLimitMb = parseBoundedInteger(
    environment[API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.memoryLimitMb],
    API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.memoryLimitMb,
    DEFAULT_MEMORY_LIMIT_MB,
    MIN_MEMORY_LIMIT_MB,
    MAX_MEMORY_LIMIT_MB
  );
  const stackLimitKb = parseBoundedInteger(
    environment[API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.stackLimitKb],
    API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.stackLimitKb,
    DEFAULT_STACK_LIMIT_KB,
    MIN_STACK_LIMIT_KB,
    MAX_STACK_LIMIT_KB
  );

  return Object.freeze({
    workerCount,
    memoryLimitBytes: memoryLimitMb * 1024 * 1024,
    stackLimitBytes: stackLimitKb * 1024,
  });
}
