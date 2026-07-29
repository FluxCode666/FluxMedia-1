/**
 * 系统设置两级缓存的 DB-free 单测。
 *
 * 使用内存 Redis mock 覆盖默认 DB、序列化校验、cache-aside、写后失效与 Redis
 * 故障降级，避免测试依赖真实 Redis 或 PostgreSQL。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SYSTEM_SETTINGS_CACHE_KEY = "fluxmedia:v1:system-settings";
const TEST_SYSTEM_SETTINGS_CACHE_EPOCH_KEY =
  "fluxmedia:v1:system-settings:epoch";

const redisMockState = vi.hoisted(() => ({
  connectFailure: false,
  store: new Map<string, string>(),
  connectionOptions: [] as Array<{
    db: number;
    host: string;
    password: string;
    port: number;
    username: string | undefined;
  }>,
  deletedKeys: [] as string[],
  pauseNextCompareAndSet: false,
  compareAndSetStarted: undefined as (() => void) | undefined,
  compareAndSetRelease: undefined as Promise<void> | undefined,
}));

vi.mock("ioredis", () => ({
  default: class RedisMock {
    status = "wait";

    constructor(options: {
      db: number;
      host: string;
      password: string;
      port: number;
      username?: string;
    }) {
      redisMockState.connectionOptions.push({
        db: options.db,
        host: options.host,
        password: options.password,
        port: options.port,
        username: options.username,
      });
    }

    on() {
      return this;
    }

    async connect() {
      if (redisMockState.connectFailure) {
        this.status = "end";
        throw new Error("connection failed");
      }
      this.status = "ready";
    }

    async get(key: string) {
      return redisMockState.store.get(key) ?? null;
    }

    async set(key: string, value: string) {
      redisMockState.store.set(key, value);
      return "OK";
    }

    async del(key: string) {
      redisMockState.deletedKeys.push(key);
      return redisMockState.store.delete(key) ? 1 : 0;
    }

    async eval(script: string, keyCount: number, ...parameters: string[]) {
      const keys = parameters.slice(0, keyCount);
      const arguments_ = parameters.slice(keyCount);
      const epochKey = keys[0];
      const cacheKey = keys[1];
      if (!epochKey || !cacheKey) {
        throw new Error("Redis 脚本缺少缓存 key");
      }

      if (script.includes('redis.pcall("INCR"')) {
        const currentEpoch = Number(redisMockState.store.get(epochKey) ?? "0");
        const nextEpoch =
          Number.isSafeInteger(currentEpoch) && currentEpoch >= 0
            ? currentEpoch + 1
            : 1;
        redisMockState.store.set(epochKey, String(nextEpoch));
        redisMockState.deletedKeys.push(cacheKey);
        redisMockState.store.delete(cacheKey);
        return nextEpoch;
      }

      if (script.includes("current_epoch ~= ARGV[1]")) {
        if (redisMockState.pauseNextCompareAndSet) {
          redisMockState.pauseNextCompareAndSet = false;
          redisMockState.compareAndSetStarted?.();
          await redisMockState.compareAndSetRelease;
        }
        const currentEpoch = redisMockState.store.get(epochKey) ?? "0";
        if (currentEpoch !== arguments_[0]) return 0;
        const serialized = arguments_[1];
        if (!serialized) throw new Error("Redis 脚本缺少缓存内容");
        redisMockState.store.set(cacheKey, serialized);
        return 1;
      }

      throw new Error("测试遇到未知 Redis 脚本");
    }

    disconnect() {
      this.status = "end";
    }
  },
}));

/**
 * 写入标准 Redis 的拆分环境变量。
 *
 * @param values - 覆盖默认本地 Redis 配置的字段。
 * @returns 无返回值。
 */
function configureRedisEnvironment(
  values: Partial<{
    host: string;
    password: string;
    port: string;
    username: string;
  }> = {}
) {
  process.env.REDIS_HOST = values.host ?? "127.0.0.1";
  process.env.REDIS_PORT = values.port ?? "6379";
  process.env.REDIS_USERNAME = values.username ?? "";
  process.env.REDIS_PASSWORD = values.password ?? "test-password";
}

/**
 * 清理标准 Redis 的拆分环境变量，避免不同测试相互污染。
 *
 * @returns 无返回值。
 */
function clearRedisEnvironment() {
  delete process.env.REDIS_DB;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PORT;
  delete process.env.REDIS_USERNAME;
  delete process.env.REDIS_PASSWORD;
}

vi.mock("../logger", () => ({
  logWarn: vi.fn(),
}));

import {
  clearLocalSystemSettingsCache,
  getSystemSettingsRedisDatabase,
  invalidateSystemSettingsCache,
  loadCachedSystemSettings,
  parseSystemSettingsCache,
  resetSystemSettingsCacheForTests,
  serializeSystemSettingsCache,
} from "./cache";

describe("system settings cache", () => {
  beforeEach(() => {
    redisMockState.connectFailure = false;
    redisMockState.store.clear();
    redisMockState.connectionOptions = [];
    redisMockState.deletedKeys = [];
    redisMockState.pauseNextCompareAndSet = false;
    redisMockState.compareAndSetStarted = undefined;
    redisMockState.compareAndSetRelease = undefined;
    clearRedisEnvironment();
    delete process.env.SYSTEM_SETTINGS_LOCAL_CACHE_TTL_MS;
    delete process.env.SYSTEM_SETTINGS_CACHE_TTL_SECONDS;
    resetSystemSettingsCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSystemSettingsCacheForTests();
    clearRedisEnvironment();
    delete process.env.SYSTEM_SETTINGS_LOCAL_CACHE_TTL_MS;
    delete process.env.SYSTEM_SETTINGS_CACHE_TTL_SECONDS;
  });

  it("defaults to Redis database 4 and rejects invalid database numbers", () => {
    expect(getSystemSettingsRedisDatabase()).toBe(4);

    process.env.REDIS_DB = "9";
    expect(getSystemSettingsRedisDatabase()).toBe(9);

    process.env.REDIS_DB = "16";
    expect(getSystemSettingsRedisDatabase()).toBe(4);

    process.env.REDIS_DB = "not-a-number";
    expect(getSystemSettingsRedisDatabase()).toBe(4);
  });

  it("round-trips typed values and rejects malformed cache payloads", () => {
    const values = new Map<string, unknown>([
      ["ENABLED", true],
      ["LIMIT", 12],
      ["JSON", { version: 1 }],
    ]);

    expect(
      parseSystemSettingsCache(serializeSystemSettingsCache(values))
    ).toEqual(values);
    expect(parseSystemSettingsCache("not-json")).toBeUndefined();
    expect(
      parseSystemSettingsCache(JSON.stringify({ version: 2, values: [] }))
    ).toBeUndefined();
  });

  it("reads through Redis after the first database load", async () => {
    configureRedisEnvironment({
      host: "172.17.0.1",
      password: "raw/password-with-special-characters",
      port: "6380",
      username: "cache-user",
    });
    const loader = vi.fn(
      async () =>
        new Map<string, unknown>([["NEXT_PUBLIC_APP_NAME", "FluxMedia"]])
    );

    await expect(loadCachedSystemSettings(loader)).resolves.toEqual(
      new Map([["NEXT_PUBLIC_APP_NAME", "FluxMedia"]])
    );
    clearLocalSystemSettingsCache();
    await expect(loadCachedSystemSettings(loader)).resolves.toEqual(
      new Map([["NEXT_PUBLIC_APP_NAME", "FluxMedia"]])
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(redisMockState.connectionOptions).toEqual([
      {
        db: 4,
        host: "172.17.0.1",
        password: "raw/password-with-special-characters",
        port: 6380,
        username: "cache-user",
      },
    ]);
    expect(redisMockState.store.size).toBe(1);
  });

  it("invalidates Redis and reloads the database on the next read", async () => {
    configureRedisEnvironment();
    let currentValue = "UTC";
    const loader = vi.fn(
      async () =>
        new Map<string, unknown>([["NEXT_PUBLIC_APP_NAME", currentValue]])
    );

    await loadCachedSystemSettings(loader);
    currentValue = "Asia/Tokyo";
    await invalidateSystemSettingsCache();

    await expect(loadCachedSystemSettings(loader)).resolves.toEqual(
      new Map([["NEXT_PUBLIC_APP_NAME", "Asia/Tokyo"]])
    );
    expect(loader).toHaveBeenCalledTimes(2);
    expect(redisMockState.deletedKeys.length).toBeGreaterThan(0);
  });

  it("失效期间的旧读取不得覆盖新一代本地与 Redis 缓存", async () => {
    configureRedisEnvironment();
    let resolveOldLoad: ((value: Map<string, unknown>) => void) | undefined;
    let resolveFreshLoad: ((value: Map<string, unknown>) => void) | undefined;
    const loader = vi
      .fn<() => Promise<Map<string, unknown>>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldLoad = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFreshLoad = resolve;
          })
      );

    const oldRead = loadCachedSystemSettings(loader);
    await vi.waitFor(() => expect(resolveOldLoad).toBeTypeOf("function"));
    await invalidateSystemSettingsCache();
    const freshRead = loadCachedSystemSettings(loader);
    await vi.waitFor(() => expect(resolveFreshLoad).toBeTypeOf("function"));

    resolveOldLoad?.(
      new Map<string, unknown>([["MODEL_MARKETPLACE_CONFIG", "old"]])
    );
    await oldRead;
    const joinedFreshRead = loadCachedSystemSettings(loader);
    resolveFreshLoad?.(
      new Map<string, unknown>([["MODEL_MARKETPLACE_CONFIG", "fresh"]])
    );

    await expect(freshRead).resolves.toEqual(
      new Map([["MODEL_MARKETPLACE_CONFIG", "fresh"]])
    );
    await expect(joinedFreshRead).resolves.toEqual(
      new Map([["MODEL_MARKETPLACE_CONFIG", "fresh"]])
    );
    clearLocalSystemSettingsCache();
    await expect(loadCachedSystemSettings(loader)).resolves.toEqual(
      new Map([["MODEL_MARKETPLACE_CONFIG", "fresh"]])
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("跨实例失效后拒绝已经开始的旧 Redis 回填", async () => {
    configureRedisEnvironment();
    let notifyCompareAndSetStarted: (() => void) | undefined;
    let releaseCompareAndSet: (() => void) | undefined;
    const compareAndSetStarted = new Promise<void>((resolve) => {
      notifyCompareAndSetStarted = resolve;
    });
    redisMockState.compareAndSetRelease = new Promise<void>((resolve) => {
      releaseCompareAndSet = resolve;
    });
    redisMockState.compareAndSetStarted = notifyCompareAndSetStarted;
    redisMockState.pauseNextCompareAndSet = true;
    const loader = vi
      .fn<() => Promise<Map<string, unknown>>>()
      .mockResolvedValueOnce(new Map([["MODEL_MARKETPLACE_CONFIG", "old"]]))
      .mockResolvedValueOnce(new Map([["MODEL_MARKETPLACE_CONFIG", "fresh"]]));

    const oldRead = loadCachedSystemSettings(loader);
    await compareAndSetStarted;
    // 模拟另一实例原子推进共享 epoch 并删除数据；当前模块的本地代次保持不变。
    redisMockState.store.set(TEST_SYSTEM_SETTINGS_CACHE_EPOCH_KEY, "1");
    redisMockState.store.delete(TEST_SYSTEM_SETTINGS_CACHE_KEY);
    releaseCompareAndSet?.();
    await expect(oldRead).resolves.toEqual(
      new Map([["MODEL_MARKETPLACE_CONFIG", "fresh"]])
    );
    await expect(loadCachedSystemSettings(loader)).resolves.toEqual(
      new Map([["MODEL_MARKETPLACE_CONFIG", "fresh"]])
    );
    expect(loader).toHaveBeenCalledTimes(2);
    clearLocalSystemSettingsCache();
    await expect(loadCachedSystemSettings(loader)).resolves.toEqual(
      new Map([["MODEL_MARKETPLACE_CONFIG", "fresh"]])
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("falls back to the database when Redis is unavailable", async () => {
    configureRedisEnvironment();
    redisMockState.connectFailure = true;
    const loader = vi.fn(
      async () => new Map<string, unknown>([["SELF_USE_MODE_ENABLED", true]])
    );

    await expect(loadCachedSystemSettings(loader)).resolves.toEqual(
      new Map([["SELF_USE_MODE_ENABLED", true]])
    );
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("recreates an ended Redis client after the failure cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
    configureRedisEnvironment();
    redisMockState.connectFailure = true;
    const loader = vi.fn(
      async () => new Map<string, unknown>([["NEXT_PUBLIC_APP_NAME", "UTC"]])
    );

    await loadCachedSystemSettings(loader);
    clearLocalSystemSettingsCache();
    redisMockState.connectFailure = false;
    vi.setSystemTime(new Date("2026-07-20T00:00:06.000Z"));
    await loadCachedSystemSettings(loader);

    expect(
      redisMockState.connectionOptions.map((options) => options.db)
    ).toEqual([4, 4]);
    expect(redisMockState.store.size).toBe(1);
  });

  it("falls back to the database when the Redis configuration is incomplete", async () => {
    process.env.REDIS_HOST = "127.0.0.1";
    const loader = vi.fn(
      async () => new Map<string, unknown>([["NEXT_PUBLIC_APP_NAME", "UTC"]])
    );

    await expect(loadCachedSystemSettings(loader)).resolves.toEqual(
      new Map([["NEXT_PUBLIC_APP_NAME", "UTC"]])
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(redisMockState.connectionOptions).toHaveLength(0);
  });

  it("falls back to the database when the Redis port is invalid", async () => {
    configureRedisEnvironment({ port: "not-a-port" });
    const loader = vi.fn(
      async () => new Map<string, unknown>([["NEXT_PUBLIC_APP_NAME", "UTC"]])
    );

    await expect(loadCachedSystemSettings(loader)).resolves.toEqual(
      new Map([["NEXT_PUBLIC_APP_NAME", "UTC"]])
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(redisMockState.connectionOptions).toHaveLength(0);
  });
});
