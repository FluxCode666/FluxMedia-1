/**
 * BullMQ Redis 连接配置。
 *
 * 职责：复用必填 Redis 的严格环境校验，同时为短命令生产者与阻塞 Worker 创建独立
 * 连接参数。禁止复用并发槽客户端，避免阻塞命令和短超时相互破坏。
 */

import {
  type RequiredRedisConnectionConfiguration,
  readRequiredRedisConnectionConfiguration,
} from "@repo/shared/redis/required-client";
import type { RedisOptions } from "bullmq";

/** BullMQ 连接用途决定重试和命令超时语义。 */
export type MediaTaskRedisConnectionKind = "producer" | "worker";

/**
 * 从已校验配置构造 BullMQ 专用 ioredis 参数。
 *
 * @param configuration 不含默认缺口的必填 Redis 配置。
 * @param kind 生产者使用有界命令重试；Worker 阻塞连接必须无限命令重试。
 * @returns 可交给 BullMQ Queue 或 Worker 的新连接参数。
 */
export function createMediaTaskRedisConnectionOptions(
  configuration: RequiredRedisConnectionConfiguration,
  kind: MediaTaskRedisConnectionKind
): RedisOptions {
  return {
    host: configuration.host,
    port: configuration.port,
    ...(configuration.username ? { username: configuration.username } : {}),
    password: configuration.password,
    db: configuration.database,
    connectTimeout: 1_000,
    enableOfflineQueue: true,
    maxRetriesPerRequest: kind === "worker" ? null : 1,
    ...(kind === "producer" ? { commandTimeout: 2_000 } : {}),
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),
  };
}

/**
 * 读取当前环境并创建 BullMQ 专用连接参数。
 *
 * @param kind 目标连接用途。
 * @returns 已严格验证且不共享客户端状态的连接参数。
 * @throws Redis 环境缺失或非法时阻止队列启动。
 */
export function getMediaTaskRedisConnectionOptions(
  kind: MediaTaskRedisConnectionKind
): RedisOptions {
  return createMediaTaskRedisConnectionOptions(
    readRequiredRedisConnectionConfiguration(),
    kind
  );
}
