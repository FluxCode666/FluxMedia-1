/**
 * 必填标准 Redis 客户端。
 *
 * 使用方：需要跨副本一致性且禁止进程内降级的运行时基础设施。连接参数只来自部署
 * 环境；系统设置缓存仍保留自己的可降级客户端，两者不得共享失败语义。
 */

import Redis from "ioredis";
import { z } from "zod";

const DEFAULT_REDIS_DATABASE = 4;
const DEFAULT_REDIS_PORT = 6379;

const requiredRedisEnvironmentSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((value) => !/[\s/?#@]/.test(value)),
  port: z.coerce.number().int().min(1).max(65_535),
  username: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(1).max(1_024),
  database: z.coerce.number().int().min(0).max(15),
});

export type RequiredRedisConnectionConfiguration = z.infer<
  typeof requiredRedisEnvironmentSchema
>;

type RequiredRedisGlobal = typeof globalThis & {
  __fluxMediaRequiredRedis?: {
    client: Redis;
    fingerprint: string;
  };
};

const requiredRedisGlobal = globalThis as RequiredRedisGlobal;

/**
 * 读取并严格校验 Redis 环境配置。
 *
 * @param environment 部署环境变量；测试可传入隔离对象。
 * @returns 可直接交给 ioredis 的拆分配置。
 * @throws Redis 未配置或字段非法时显式失败，不提供内存或数据库回退。
 */
export function readRequiredRedisConnectionConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env
): RequiredRedisConnectionConfiguration {
  const parsed = requiredRedisEnvironmentSchema.safeParse({
    host: environment.REDIS_HOST,
    port: environment.REDIS_PORT ?? String(DEFAULT_REDIS_PORT),
    username: environment.REDIS_USERNAME?.trim() || undefined,
    password: environment.REDIS_PASSWORD,
    database: environment.REDIS_DB ?? String(DEFAULT_REDIS_DATABASE),
  });
  if (!parsed.success) {
    const invalidFields = Array.from(
      new Set(parsed.error.issues.map((issue) => issue.path[0]))
    )
      .map((field) => {
        if (field === "host") return "REDIS_HOST";
        if (field === "port") return "REDIS_PORT";
        if (field === "username") return "REDIS_USERNAME";
        if (field === "password") return "REDIS_PASSWORD";
        return "REDIS_DB";
      })
      .join(", ");
    throw new Error(
      `Redis is required and the following configuration is missing or invalid: ${invalidFields}`
    );
  }
  return parsed.data;
}

/**
 * 创建或复用进程级必填 Redis 客户端。
 *
 * @returns 当前环境配置对应的懒连接客户端。
 * @throws 配置缺失时立即失败；连接错误由实际命令或启动探针上抛。
 */
export function getRequiredRedisClient(): Redis {
  const configuration = readRequiredRedisConnectionConfiguration();
  const fingerprint = JSON.stringify([
    configuration.host,
    configuration.port,
    configuration.username,
    configuration.password,
    configuration.database,
  ]);
  const current = requiredRedisGlobal.__fluxMediaRequiredRedis;
  if (current?.fingerprint === fingerprint && current.client.status !== "end") {
    return current.client;
  }
  current?.client.disconnect();

  const client = new Redis({
    host: configuration.host,
    port: configuration.port,
    ...(configuration.username ? { username: configuration.username } : {}),
    password: configuration.password,
    db: configuration.database,
    lazyConnect: true,
    connectTimeout: 1_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  client.on("error", () => {
    // 命令调用方负责记录不含连接参数的错误分类；监听器仅防止未处理事件终止进程。
  });
  requiredRedisGlobal.__fluxMediaRequiredRedis = { client, fingerprint };
  return client;
}

/**
 * 在应用启动阶段验证必填 Redis 已可接受命令。
 *
 * @returns Redis 返回 PONG 后完成。
 * @throws 配置缺失、连接超时、认证失败或响应异常时阻止应用启动。
 */
export async function ensureRequiredRedisReady(): Promise<void> {
  try {
    const client = getRequiredRedisClient();
    if (client.status === "wait") await client.connect();
    const response = await client.ping();
    if (response !== "PONG")
      throw new Error("Redis readiness response was invalid");
  } catch (error) {
    throw new Error(
      "Required Redis is unavailable; application startup aborted",
      {
        cause: error,
      }
    );
  }
}
