/**
 * 系统设置两级缓存。
 *
 * 使用方：system-settings/index.ts 的统一读取与写后失效入口。
 * 关键依赖：ioredis、Zod。L1 是进程内短缓存，L2 是带共享 epoch 的 Redis 缓存；
 * epoch CAS 阻止其他实例把失效前的旧数据库结果重新回填。Redis 未配置或暂时故障时
 * 回退数据库加载器，不阻断应用启动和业务请求。
 */
import Redis from "ioredis";
import { z } from "zod";

import { logWarn } from "../logger";

const SYSTEM_SETTINGS_CACHE_KEY = "fluxmedia:v1:system-settings";
const SYSTEM_SETTINGS_CACHE_EPOCH_KEY = "fluxmedia:v1:system-settings:epoch";
const DEFAULT_REDIS_DATABASE = 4;
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_CACHE_TTL_SECONDS = 60;
const DEFAULT_LOCAL_CACHE_TTL_MS = 1_000;
const DEFAULT_DATABASE_FALLBACK_CACHE_TTL_MS = 10_000;
const REDIS_FAILURE_COOLDOWN_MS = 5_000;
// WHY：失效与回填必须由 Redis 原子裁决；Node 进程内锁无法阻止其他实例的旧读取回灌。
const INVALIDATE_REDIS_CACHE_SCRIPT = `
local next_epoch = redis.pcall("INCR", KEYS[1])
if type(next_epoch) == "table" or next_epoch < 1 then
  next_epoch = 1
  redis.call("SET", KEYS[1], "1")
end
redis.call("DEL", KEYS[2])
return next_epoch
`;
const WRITE_REDIS_CACHE_IF_EPOCH_MATCHES_SCRIPT = `
local current_epoch = redis.call("GET", KEYS[1])
if not current_epoch then
  current_epoch = "0"
end
if current_epoch ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
return 1
`;

const cachedSettingsSchema = z.object({
  version: z.literal(1),
  values: z.array(z.tuple([z.string(), z.unknown()])),
});

type CachedSettingsPayload = z.infer<typeof cachedSettingsSchema>;
type SettingsLoader = () => Promise<Map<string, unknown>>;
type SettingsLoadResult = {
  values: Map<string, unknown>;
  cacheable: boolean;
};
type RedisCacheWriteResult =
  | "written"
  | "epoch_changed"
  | "local_invalidated"
  | "unavailable";
type RedisConnectionConfiguration = {
  host: string;
  port: number;
  username: string | undefined;
  password: string;
  database: number;
};

const redisConnectionEnvironmentSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((value) => !/[\s/?#@]/.test(value), {
      message: "Redis 主机地址不能包含 URL 分隔符或空白字符",
    }),
  port: z
    .string()
    .trim()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
  username: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(1).max(1_024),
});

let localCache:
  | {
      expiresAt: number;
      values: Map<string, unknown>;
    }
  | undefined;
let inFlightLoad: Promise<Map<string, unknown>> | undefined;
let cacheGeneration = 0;
let redisClient: Redis | undefined;
let redisClientFingerprint: string | undefined;
let redisUnavailableUntil = 0;
let pendingRedisInvalidationGeneration: number | undefined;
let lastRedisWarningAt = 0;

/**
 * 将环境变量解析为有界整数。
 *
 * @param rawValue - 未受信任的环境变量文本。
 * @param fallback - 缺失或非法时的回退值。
 * @param bounds - 允许的闭区间。
 * @returns 位于闭区间内的整数。
 */
function parseBoundedInteger(
  rawValue: string | undefined,
  fallback: number,
  bounds: { min: number; max: number }
) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    return fallback;
  }
  return parsed;
}

/**
 * 读取 Redis DB 编号。
 *
 * @returns REDIS_DB 的合法值；未配置时固定使用 4 号库。
 */
export function getSystemSettingsRedisDatabase() {
  return parseBoundedInteger(process.env.REDIS_DB, DEFAULT_REDIS_DATABASE, {
    min: 0,
    max: 15,
  });
}

/**
 * 读取并校验标准 Redis 的拆分连接配置。
 *
 * @returns 未配置主机时返回 undefined；配置不完整或非法时记录脱敏告警并回退。
 * @remarks 密码作为 ioredis 独立选项传递，不会拼接为 URL，因此无需进行 URL 编码。
 */
function getRedisConnectionConfiguration():
  | RedisConnectionConfiguration
  | undefined {
  const host = process.env.REDIS_HOST?.trim();
  if (!host) return undefined;

  const username = process.env.REDIS_USERNAME?.trim() || undefined;
  const parsed = redisConnectionEnvironmentSchema.safeParse({
    host,
    port: process.env.REDIS_PORT ?? String(DEFAULT_REDIS_PORT),
    username,
    password: process.env.REDIS_PASSWORD,
  });
  if (!parsed.success) {
    warnRedisFallback("configuration", parsed.error);
    return undefined;
  }

  return {
    host: parsed.data.host,
    port: parsed.data.port,
    username: parsed.data.username,
    password: parsed.data.password,
    database: getSystemSettingsRedisDatabase(),
  };
}

/**
 * 读取共享缓存 TTL，并限制极端配置避免雪崩或长期脏缓存。
 *
 * @returns Redis 缓存秒数，默认 60 秒。
 */
function getRedisCacheTtlSeconds() {
  return parseBoundedInteger(
    process.env.SYSTEM_SETTINGS_CACHE_TTL_SECONDS,
    DEFAULT_REDIS_CACHE_TTL_SECONDS,
    { min: 10, max: 3_600 }
  );
}

/**
 * 读取 L1 缓存 TTL。
 *
 * @returns 进程内缓存毫秒数，默认 1 秒。
 */
function getLocalCacheTtlMs() {
  return parseBoundedInteger(
    process.env.SYSTEM_SETTINGS_LOCAL_CACHE_TTL_MS,
    DEFAULT_LOCAL_CACHE_TTL_MS,
    { min: 100, max: 10_000 }
  );
}

/**
 * 判断系统设置 Redis 是否已配置。
 *
 * @returns Redis 主机、端口和密码均合法时为 true。
 */
function isRedisConfigured() {
  return getRedisConnectionConfiguration() !== undefined;
}

/**
 * 以限频方式记录 Redis 降级，不输出连接串或缓存内容。
 *
 * @param operation - 失败的缓存操作名。
 * @param error - 原始错误，仅记录安全的错误类型。
 */
function warnRedisFallback(operation: string, error: unknown) {
  const now = Date.now();
  if (now - lastRedisWarningAt < REDIS_FAILURE_COOLDOWN_MS) return;
  lastRedisWarningAt = now;
  logWarn("系统设置 Redis 缓存不可用，已回退数据库", {
    operation,
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
}

/**
 * 创建或复用 Redis 客户端。
 *
 * 连接配置仅来自部署环境，避免系统设置缓存依赖自身才能完成初始化。客户端默认
 * 选择 4 号库，并设置短连接/命令超时和有限重试，防止 Redis 故障拖住主链路。
 *
 * @returns 已配置时返回进程级客户端，否则返回 undefined。
 */
function getRedisClient() {
  const configuration = getRedisConnectionConfiguration();
  if (!configuration) return undefined;

  const fingerprint = JSON.stringify([
    configuration.host,
    configuration.port,
    configuration.username,
    configuration.password,
    configuration.database,
  ]);
  const configurationChanged = redisClientFingerprint !== fingerprint;
  if (
    redisClient &&
    redisClientFingerprint === fingerprint &&
    redisClient.status !== "end"
  ) {
    return redisClient;
  }

  if (redisClient) {
    redisClient.disconnect();
  }

  redisClient = new Redis({
    host: configuration.host,
    port: configuration.port,
    ...(configuration.username ? { username: configuration.username } : {}),
    password: configuration.password,
    db: configuration.database,
    lazyConnect: true,
    connectTimeout: 750,
    commandTimeout: 750,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    retryStrategy: () => null,
  });
  redisClient.on("error", () => {
    // 命令调用处统一分类并限频记录；error 事件只负责避免未监听事件终止进程。
  });
  redisClientFingerprint = fingerprint;
  if (configurationChanged) {
    redisUnavailableUntil = 0;
  }
  return redisClient;
}

/**
 * 确保懒连接客户端已连接。
 *
 * @param client - 当前 Redis 客户端。
 * @throws 连接失败或处于不可恢复状态时抛出，由调用方统一降级。
 */
async function ensureRedisConnected(client: Redis) {
  if (client.status === "wait") {
    await client.connect();
    return;
  }
  if (client.status === "end") {
    throw new Error("Redis client is closed");
  }
}

/**
 * 执行可降级的 Redis 操作。
 *
 * @param operation - 观测用操作名，不包含敏感信息。
 * @param run - 实际 Redis 命令。
 * @param options - force 用于写后失效，即使熔断窗口内也尝试一次。
 * @returns 操作结果；未配置、熔断或失败时返回 undefined。
 */
async function runRedisOperation<T>(
  operation: string,
  run: (client: Redis) => Promise<T>,
  options?: { force?: boolean }
): Promise<T | undefined> {
  try {
    const client = getRedisClient();
    if (!client) return undefined;
    if (!options?.force && redisUnavailableUntil > Date.now()) return undefined;
    await ensureRedisConnected(client);
    const result = await run(client);
    redisUnavailableUntil = 0;
    return result;
  } catch (error) {
    redisUnavailableUntil = Date.now() + REDIS_FAILURE_COOLDOWN_MS;
    warnRedisFallback(operation, error);
    return undefined;
  }
}

/**
 * 将 Map 序列化为带版本的 JSON。
 *
 * @param values - 已由数据库规范化的系统设置。
 * @returns 可写入 Redis 的 JSON 文本。
 */
export function serializeSystemSettingsCache(values: Map<string, unknown>) {
  const payload: CachedSettingsPayload = {
    version: 1,
    values: [...values.entries()],
  };
  return JSON.stringify(payload);
}

/**
 * 校验并反序列化 Redis 缓存。
 *
 * @param rawValue - Redis 返回的未受信任文本。
 * @returns 合法 Map；损坏、旧版本或非 JSON 时返回 undefined 触发回源。
 */
export function parseSystemSettingsCache(rawValue: string) {
  try {
    const parsed = cachedSettingsSchema.safeParse(JSON.parse(rawValue));
    return parsed.success ? new Map(parsed.data.values) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从 Redis 读取系统设置全集。
 *
 * 待处理的写后失效会优先推进共享 epoch 并删除旧 key，避免 Redis 故障恢复后重新
 * 读到故障前数据。读取同时返回 epoch，供数据库回填执行跨实例 CAS。
 *
 * @returns Redis 可用时返回 epoch 与可选命中值；Redis 不可用时返回 undefined。
 */
async function readSettingsFromRedis() {
  const pendingGeneration = pendingRedisInvalidationGeneration;
  if (pendingGeneration !== undefined) {
    await invalidateRedisCache(pendingGeneration);
  }

  return runRedisOperation("read", async (client) => {
    const rawEpoch = await client.get(SYSTEM_SETTINGS_CACHE_EPOCH_KEY);
    const epoch = rawEpoch === null ? "0" : rawEpoch;
    if (!/^(0|[1-9]\d*)$/.test(epoch)) {
      await client.del(SYSTEM_SETTINGS_CACHE_KEY);
      return { epoch: "invalid" };
    }
    const rawValue = await client.get(SYSTEM_SETTINGS_CACHE_KEY);
    if (typeof rawValue !== "string") return { epoch };
    const parsed = parseSystemSettingsCache(rawValue);
    if (!parsed) {
      await client.del(SYSTEM_SETTINGS_CACHE_KEY);
    }
    return { epoch, values: parsed };
  });
}

/**
 * 原子推进 Redis 共享 epoch 并删除旧设置缓存。
 *
 * @param invalidationGeneration - 当前进程发起失效时的本地代次。
 * @returns 无返回；Redis 失败时保留同一代次供后续读取重试。
 */
async function invalidateRedisCache(
  invalidationGeneration: number
): Promise<void> {
  const invalidatedEpoch = await runRedisOperation(
    "invalidate",
    async (client) => {
      const result: unknown = await client.eval(
        INVALIDATE_REDIS_CACHE_SCRIPT,
        2,
        SYSTEM_SETTINGS_CACHE_EPOCH_KEY,
        SYSTEM_SETTINGS_CACHE_KEY
      );
      return z
        .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
        .transform(String)
        .parse(result);
    },
    { force: true }
  );
  if (
    invalidatedEpoch !== undefined &&
    pendingRedisInvalidationGeneration === invalidationGeneration
  ) {
    pendingRedisInvalidationGeneration = undefined;
  }
}

/**
 * 将数据库回源结果写入 Redis。
 *
 * TTL 加入最多 10% 的随机抖动，降低多实例同一时刻集中过期的风险。写缓存
 * 失败不改变数据库读取结果，由后续请求继续回源。
 *
 * @param values - 数据库返回的完整系统设置 Map。
 * @param expectedGeneration - 发起数据库读取时绑定的本地缓存代次。
 * @param expectedRedisEpoch - Redis miss 时读取的共享 epoch。
 */
async function writeSettingsToRedis(
  values: Map<string, unknown>,
  expectedGeneration: number,
  expectedRedisEpoch: string
): Promise<RedisCacheWriteResult> {
  if (expectedGeneration !== cacheGeneration) return "local_invalidated";
  const ttlSeconds = getRedisCacheTtlSeconds();
  const jitterSeconds = Math.floor(
    Math.random() * Math.max(1, ttlSeconds * 0.1)
  );
  const writeResult = await runRedisOperation("write", async (client) => {
    if (expectedGeneration !== cacheGeneration) {
      return "local_invalidated" as const;
    }
    const result: unknown = await client.eval(
      WRITE_REDIS_CACHE_IF_EPOCH_MATCHES_SCRIPT,
      2,
      SYSTEM_SETTINGS_CACHE_EPOCH_KEY,
      SYSTEM_SETTINGS_CACHE_KEY,
      expectedRedisEpoch,
      serializeSystemSettingsCache(values),
      String(ttlSeconds + jitterSeconds)
    );
    const parsed = z
      .union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")])
      .transform(Number)
      .parse(result);
    return parsed === 1 ? ("written" as const) : ("epoch_changed" as const);
  });
  return writeResult ?? "unavailable";
}

/**
 * 执行一次 Redis miss 后的数据库回源，并回填共享缓存。
 *
 * @param loadFromDatabase - system-settings 注入的数据库加载器。
 * @param expectedGeneration - 本次读取开始时的缓存代次。
 * @returns 当前完整系统设置及其是否可进入 L1。
 * @failure Redis epoch 变化时最多重读一次；连续冲突仍返回本次数据库
 * 结果，但明确禁止它进入 L1 或 L2。
 */
async function loadSettingsUncached(
  loadFromDatabase: SettingsLoader,
  expectedGeneration: number
): Promise<SettingsLoadResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let redisEpoch: string | undefined;
    if (isRedisConfigured()) {
      const redisResult = await readSettingsFromRedis();
      if (redisResult?.values) {
        return { values: redisResult.values, cacheable: true };
      }
      redisEpoch = redisResult?.epoch;
    }

    const databaseValues = await loadFromDatabase();
    if (!isRedisConfigured() || !redisEpoch || redisEpoch === "invalid") {
      return { values: databaseValues, cacheable: true };
    }
    const writeResult = await writeSettingsToRedis(
      databaseValues,
      expectedGeneration,
      redisEpoch
    );
    if (writeResult !== "epoch_changed") {
      return {
        values: databaseValues,
        cacheable: writeResult !== "local_invalidated",
      };
    }
    if (attempt === 1) {
      return { values: databaseValues, cacheable: false };
    }
  }
  throw new Error("系统设置缓存重读状态无效");
}

/**
 * 读取系统设置全集。
 *
 * L1 命中直接返回；miss 时同一进程内合并并发回源，优先 Redis，Redis miss 才访问
 * PostgreSQL。Redis 未配置时保留原有 10 秒本地缓存，避免可选依赖降级后放大 DB 压力。
 *
 * @param loadFromDatabase - 仅在缓存 miss 时执行的数据库加载器。
 * @returns 当前完整系统设置 Map。
 */
export async function loadCachedSystemSettings(
  loadFromDatabase: SettingsLoader
) {
  const now = Date.now();
  if (localCache && localCache.expiresAt > now) return localCache.values;
  if (inFlightLoad) return inFlightLoad;

  const expectedGeneration = cacheGeneration;
  const currentLoad = loadSettingsUncached(loadFromDatabase, expectedGeneration)
    .then((result) => {
      if (result.cacheable && expectedGeneration === cacheGeneration) {
        localCache = {
          expiresAt:
            Date.now() +
            (isRedisConfigured()
              ? getLocalCacheTtlMs()
              : DEFAULT_DATABASE_FALLBACK_CACHE_TTL_MS),
          values: result.values,
        };
      }
      return result.values;
    })
    .finally(() => {
      // WHY：失效后可能已有新一代读取在途；旧任务完成时只能释放自己的句柄。
      if (inFlightLoad === currentLoad) {
        inFlightLoad = undefined;
      }
    });
  inFlightLoad = currentLoad;
  return currentLoad;
}

/**
 * 立即清除当前进程的 L1 缓存。
 *
 * 用于测试隔离和同进程写后可见性；不会执行网络 I/O。
 */
export function clearLocalSystemSettingsCache() {
  cacheGeneration += 1;
  localCache = undefined;
  inFlightLoad = undefined;
}

/**
 * 在数据库写成功后失效 L1 与 Redis 共享缓存。
 *
 * Redis 原子失效失败时记录本地代次并继续返回成功，后续本进程首次 Redis 读会重试；
 * 成功后共享 epoch 会拒绝所有实例在失效前启动的旧数据库回填。数据库始终是真相来源。
 */
export async function invalidateSystemSettingsCache() {
  clearLocalSystemSettingsCache();
  if (!isRedisConfigured()) return;

  const invalidationGeneration = cacheGeneration;
  pendingRedisInvalidationGeneration = invalidationGeneration;
  await invalidateRedisCache(invalidationGeneration);
}

/**
 * 关闭测试或进程生命周期中的 Redis 客户端并清空模块状态。
 *
 * 生产代码通常无需调用；导出用于 DB-free 故障与连接配置测试，确保句柄不泄漏。
 */
export function resetSystemSettingsCacheForTests() {
  clearLocalSystemSettingsCache();
  redisClient?.disconnect();
  redisClient = undefined;
  redisClientFingerprint = undefined;
  redisUnavailableUntil = 0;
  pendingRedisInvalidationGeneration = undefined;
  lastRedisWarningAt = 0;
}
