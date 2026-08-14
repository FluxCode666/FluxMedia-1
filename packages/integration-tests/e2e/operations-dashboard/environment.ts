/**
 * 运营总览浏览器测试的隔离环境契约。
 *
 * 使用方：Playwright 配置、数据库夹具与真实登录 setup。该模块只接受显式 E2E
 * 变量，复用 PostgreSQL/Redis 安全校验器，并拒绝远程 base URL，避免误操作开发或
 * 生产环境。
 */

import { resolve } from "node:path";

import { requireDedicatedTestDatabaseUrl } from "../../src/test-database-url";
import { requireDedicatedTestRedisConnection } from "../../src/test-redis-connection";

const DEFAULT_BASE_URL = "http://localhost:3107";
const DEFAULT_WEB_PORT = 3107;
const OPERATIONS_E2E_STORAGE_PATH = resolve(
  import.meta.dirname,
  "../../test-results/operations-dashboard/storage"
);
const OPERATIONS_E2E_STORAGE_BUCKET = "operations-e2e";

/** 浏览器夹具覆盖的四种真实用户角色。 */
export const OPERATIONS_E2E_USERS = {
  user: {
    id: "operations-e2e-user",
    email: "operations-e2e-user@example.test",
    name: "Operations E2E User",
    role: "user",
  },
  observer_admin: {
    id: "operations-e2e-observer",
    email: "operations-e2e-observer@example.test",
    name: "Operations E2E Observer",
    role: "observer_admin",
  },
  admin: {
    id: "operations-e2e-admin",
    email: "operations-e2e-admin@example.test",
    name: "Operations E2E Admin",
    role: "admin",
  },
  super_admin: {
    id: "operations-e2e-super-admin",
    email: "operations-e2e-super-admin@example.test",
    name: "Operations E2E Super Admin",
    role: "super_admin",
  },
} as const;

export type OperationsE2EUserRole = keyof typeof OPERATIONS_E2E_USERS;

/** Playwright 认证状态目录；产物由 .gitignore 排除。 */
export const OPERATIONS_AUTH_STATE_DIRECTORY = resolve(
  import.meta.dirname,
  "../.auth"
);

export type OperationsE2EEnvironment = {
  databaseUrl: string;
  redis: {
    host: string;
    port: number;
    username?: string;
    password: string;
    tls: boolean;
    database: 15;
  };
  baseUrl: string;
  port: number;
  password: string;
  betterAuthSecret: string;
  localStoragePath: string;
  storageBucketName: string;
};

/** 读取必填机密，错误只指出变量名，不回显值。 */
function requireSecret(name: string, minimumLength: number): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} 未设置或长度不足 ${minimumLength}`);
  }
  return value;
}

/**
 * 读取运营 E2E 的全部隔离依赖。
 *
 * @returns 已验证数据库、Redis、认证和本机 URL 配置。
 * @throws 任一专用变量缺失或不满足隔离规则时立即停止。
 * @sideEffect 只读 process.env，不建立连接、不记录凭据。
 */
export function requireOperationsE2EEnvironment(): OperationsE2EEnvironment {
  const databaseUrl = requireDedicatedTestDatabaseUrl(
    "OPERATIONS_E2E_DATABASE_URL"
  );
  const redis = requireDedicatedTestRedisConnection(
    "OPERATIONS_E2E_REDIS_URL",
    "producer"
  );
  if (!redis.password) {
    throw new Error(
      "OPERATIONS_E2E_REDIS_URL 必须包含测试 Redis 密码，应用运行时不允许空密码"
    );
  }
  return {
    databaseUrl,
    redis: {
      host: redis.host ?? "",
      port: redis.port ?? 6379,
      ...(redis.username ? { username: redis.username } : {}),
      password: redis.password,
      tls: Boolean(redis.tls),
      database: 15,
    },
    baseUrl: DEFAULT_BASE_URL,
    port: DEFAULT_WEB_PORT,
    password: requireSecret("OPERATIONS_E2E_USER_PASSWORD", 12),
    betterAuthSecret: requireSecret("OPERATIONS_E2E_BETTER_AUTH_SECRET", 32),
    localStoragePath: OPERATIONS_E2E_STORAGE_PATH,
    storageBucketName: OPERATIONS_E2E_STORAGE_BUCKET,
  };
}

/** 返回指定角色的忽略型认证状态路径。 */
export function getOperationsAuthStatePath(
  role: OperationsE2EUserRole
): string {
  return resolve(OPERATIONS_AUTH_STATE_DIRECTORY, `${role}.json`);
}

/**
 * 将专用连接转换为 Next.js Web 进程环境。
 *
 * @param environment 已验证的 E2E 配置。
 * @returns 强制覆盖数据库、Redis、认证 URL 和调度器开关的环境变量。
 */
export function buildOperationsWebEnvironment(
  environment: OperationsE2EEnvironment
): Record<string, string> {
  return {
    DATABASE_URL: environment.databaseUrl,
    BETTER_AUTH_SECRET: environment.betterAuthSecret,
    BETTER_AUTH_URL: environment.baseUrl,
    NEXT_PUBLIC_APP_URL: environment.baseUrl,
    APP_TIME_ZONE: "Asia/Shanghai",
    REDIS_HOST: environment.redis.host,
    REDIS_PORT: String(environment.redis.port),
    REDIS_PASSWORD: environment.redis.password,
    REDIS_DB: String(environment.redis.database),
    REDIS_TLS: String(environment.redis.tls),
    STORAGE_ENDPOINT: "",
    STORAGE_BUCKET_NAME: environment.storageBucketName,
    LOCAL_STORAGE_PATH: environment.localStoragePath,
    ...(environment.redis.username
      ? { REDIS_USERNAME: environment.redis.username }
      : {}),
    INTERNAL_JOB_SCHEDULER_ENABLED: "false",
    INTERNAL_JOB_OPERATIONS_EXPORT_PROCESS_ENABLED: "false",
    INTERNAL_JOB_OPERATIONS_EXPORT_EXPIRE_ENABLED: "false",
  };
}
