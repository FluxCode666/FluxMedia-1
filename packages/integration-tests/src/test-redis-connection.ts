/**
 * Redis 集成测试的专用连接校验器。
 *
 * 职责：只读取显式测试 URL，强制使用逻辑库 15，并按 BullMQ 连接角色生成参数。
 * 使用方：真实 Redis MQ 集成测试。
 * 关键依赖：WHATWG URL 与 BullMQ RedisOptions；不会读取生产 REDIS_* 变量。
 */

import type { RedisOptions } from "bullmq";

/** BullMQ 生产者与阻塞 Worker 使用不同的请求重试语义。 */
export type TestRedisConnectionKind = "producer" | "worker";

/**
 * 读取并验证专用 Redis 集成测试 URL。
 *
 * @param environmentVariable 只允许读取的测试环境变量名。
 * @param kind 生产者快速失败；Worker 允许阻塞命令无限重试。
 * @returns 不含 URL 原文的 BullMQ ioredis 连接参数。
 * @throws URL 缺失、协议非法、带查询参数，或逻辑库不是 15 时拒绝连接。
 * @sideEffect 仅读取指定的 process.env 字段，不记录地址或凭据。
 */
export function requireDedicatedTestRedisConnection(
  environmentVariable: string,
  kind: TestRedisConnectionKind
): RedisOptions {
  const value = process.env[environmentVariable]?.trim();
  if (!value) {
    throw new Error(`${environmentVariable} 未设置；拒绝连接默认 Redis`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${environmentVariable} 不是有效 Redis URL`);
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error(`${environmentVariable} 必须使用 Redis 协议`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${environmentVariable} 不允许查询参数或片段`);
  }
  const databaseText = parsed.pathname.replace(/^\/+/, "");
  if (databaseText !== "15") {
    throw new Error(`${environmentVariable} 必须使用专用逻辑库 15`);
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${environmentVariable} 端口非法`);
  }

  return {
    host: parsed.hostname,
    port,
    ...(parsed.username
      ? { username: decodeURIComponent(parsed.username) }
      : {}),
    ...(parsed.password
      ? { password: decodeURIComponent(parsed.password) }
      : {}),
    db: 15,
    ...(parsed.protocol === "rediss:"
      ? { tls: { servername: parsed.hostname } }
      : {}),
    enableOfflineQueue: true,
    maxRetriesPerRequest: kind === "worker" ? null : 1,
  };
}
