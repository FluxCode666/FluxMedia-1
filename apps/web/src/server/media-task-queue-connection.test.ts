/**
 * BullMQ Redis 连接配置单测。
 *
 * 使用方：Vitest；验证生产者与阻塞 Worker 不共享错误重试语义，不建立真实连接。
 */

import { describe, expect, it } from "vitest";

import { createMediaTaskRedisConnectionOptions } from "./media-task-queue-connection";

const configuration = {
  host: "redis.internal",
  port: 6_380,
  username: "worker",
  password: "secret",
  database: 7,
  tls: true,
};

describe("media task Redis connection options", () => {
  it("生产者命令使用短超时和有界重试", () => {
    expect(
      createMediaTaskRedisConnectionOptions(configuration, "producer")
    ).toMatchObject({
      host: "redis.internal",
      port: 6_380,
      username: "worker",
      password: "secret",
      db: 7,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      tls: { servername: "redis.internal" },
    });
  });

  it("Worker 阻塞连接不设置命令超时并允许持续重试", () => {
    const options = createMediaTaskRedisConnectionOptions(
      configuration,
      "worker"
    );
    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.commandTimeout).toBeUndefined();
  });
});
