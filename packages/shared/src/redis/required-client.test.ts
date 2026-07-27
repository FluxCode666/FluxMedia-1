/**
 * 必填标准 Redis 连接配置测试。
 *
 * 使用方：Vitest；验证并发槽依赖不会在缺配置时回退进程内状态，不建立真实连接。
 */

import { describe, expect, it } from "vitest";

import { readRequiredRedisConnectionConfiguration } from "./required-client";

describe("required Redis connection configuration", () => {
  it("缺少 Redis 主机或密码时拒绝启动", () => {
    expect(() =>
      readRequiredRedisConnectionConfiguration({ REDIS_PASSWORD: "secret" })
    ).toThrow(/REDIS_HOST/);
    expect(() =>
      readRequiredRedisConnectionConfiguration({ REDIS_HOST: "redis" })
    ).toThrow(/REDIS_PASSWORD/);
  });

  it("解析标准 Redis 拆分配置并限制数据库编号", () => {
    expect(
      readRequiredRedisConnectionConfiguration({
        REDIS_HOST: "redis.internal",
        REDIS_PORT: "6380",
        REDIS_USERNAME: "worker",
        REDIS_PASSWORD: "secret",
        REDIS_DB: "7",
      })
    ).toEqual({
      host: "redis.internal",
      port: 6380,
      username: "worker",
      password: "secret",
      database: 7,
    });

    expect(() =>
      readRequiredRedisConnectionConfiguration({
        REDIS_HOST: "redis.internal",
        REDIS_PASSWORD: "secret",
        REDIS_DB: "16",
      })
    ).toThrow(/REDIS_DB/);
  });
});
