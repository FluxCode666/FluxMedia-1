/**
 * Redis 生图并发槽租约。
 *
 * 使用方：`queue.ts`。全局与单用户槽位在同一 Lua 脚本内原子获取，并以有界 TTL
 * 自动回收崩溃进程遗留租约；Redis 缺失或故障时失败关闭，禁止退回进程内计数。
 */

import { createHash, randomUUID } from "node:crypto";
import { logWarn } from "@repo/shared/logger";
import { getRequiredRedisClient } from "@repo/shared/redis/required-client";
import { z } from "zod";

const SLOT_KEY_PREFIX =
  "fluxmedia:v1:image-generation:slots:{image-generation}";
const GLOBAL_SLOT_KEY = `${SLOT_KEY_PREFIX}:global`;
const USER_SLOT_KEY_PREFIX = `${SLOT_KEY_PREFIX}:user:`;
const DEFAULT_SLOT_LEASE_TTL_MS = 22 * 60_000;

const ACQUIRE_SLOT_SCRIPT = `
local clock = redis.call("TIME")
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local token = ARGV[1]
local globalLimit = tonumber(ARGV[2])
local userLimit = tonumber(ARGV[3])
local leaseTtlMs = tonumber(ARGV[4])
local expiresAt = now + leaseTtlMs

redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)

if redis.call("ZCARD", KEYS[1]) >= globalLimit then
  return {2}
end
if redis.call("ZCARD", KEYS[2]) >= userLimit then
  return {3}
end

redis.call("ZADD", KEYS[1], expiresAt, token)
redis.call("ZADD", KEYS[2], expiresAt, token)
redis.call("PEXPIRE", KEYS[1], leaseTtlMs)
redis.call("PEXPIRE", KEYS[2], leaseTtlMs)
return {1}
`;

const RELEASE_SLOT_SCRIPT = `
local removedGlobal = redis.call("ZREM", KEYS[1], ARGV[1])
local removedUser = redis.call("ZREM", KEYS[2], ARGV[1])
if redis.call("ZCARD", KEYS[1]) == 0 then redis.call("DEL", KEYS[1]) end
if redis.call("ZCARD", KEYS[2]) == 0 then redis.call("DEL", KEYS[2]) end
return removedGlobal + removedUser
`;

const acquireReplySchema = z.tuple([z.number().int().min(1).max(3)]);
const releaseReplySchema = z.number().int().min(0).max(2);

export type RedisImageGenerationSlotClient = {
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
};

export type RedisImageGenerationSlotLease = {
  token: string;
  userKey: string;
};

export type RedisImageGenerationSlotAcquisition =
  | { status: "acquired"; lease: RedisImageGenerationSlotLease }
  | { status: "blocked"; reason: "global" | "user" };

/** 将外部用户 ID 散列为固定长度 Redis key，避免原始标识进入运维键空间。 */
function getUserSlotKey(userId: string): string {
  const digest = createHash("sha256").update(userId).digest("hex");
  return `${USER_SLOT_KEY_PREFIX}${digest}`;
}

/** 读取有界槽位租约 TTL；默认覆盖完整 20 分钟生图预算并留出释放余量。 */
export function getImageGenerationSlotLeaseTtlMs(): number {
  const parsed = Number.parseInt(
    process.env.IMAGE_GENERATION_SLOT_LEASE_TTL_MS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 60_000 || parsed > 60 * 60_000) {
    return DEFAULT_SLOT_LEASE_TTL_MS;
  }
  return parsed;
}

/**
 * 使用 Redis 原子获取一个全局槽位和一个用户槽位。
 *
 * @param client 仅暴露 eval 的 Redis 客户端，便于 DB-free 单测。
 * @param input 用户身份、两级并发上限与崩溃回收 TTL。
 * @returns 成功租约，或明确的全局/用户容量阻塞原因。
 * @throws Redis 返回不受信任的异常形状时失败，不执行本地降级。
 */
export async function acquireRedisImageGenerationSlot(
  client: RedisImageGenerationSlotClient,
  input: {
    userId: string;
    globalConcurrency: number;
    userConcurrency: number;
    leaseTtlMs: number;
  }
): Promise<RedisImageGenerationSlotAcquisition> {
  const lease: RedisImageGenerationSlotLease = {
    token: randomUUID(),
    userKey: getUserSlotKey(input.userId),
  };
  const rawReply = await client.eval(
    ACQUIRE_SLOT_SCRIPT,
    2,
    GLOBAL_SLOT_KEY,
    lease.userKey,
    lease.token,
    input.globalConcurrency,
    input.userConcurrency,
    input.leaseTtlMs
  );
  const reply = acquireReplySchema.safeParse(rawReply);
  if (!reply.success) throw new Error("Invalid Redis slot response");
  if (reply.data[0] === 1) return { status: "acquired", lease };
  return {
    status: "blocked",
    reason: reply.data[0] === 2 ? "global" : "user",
  };
}

/**
 * 以租约 token 原子释放全局与用户槽位；重复释放天然幂等。
 *
 * @param client Redis 命令客户端。
 * @param lease 获取阶段返回且只在当前请求持有的租约身份。
 * @returns 两个集合中实际删除的成员数量。
 */
export async function releaseRedisImageGenerationSlot(
  client: RedisImageGenerationSlotClient,
  lease: RedisImageGenerationSlotLease
): Promise<number> {
  const rawReply = await client.eval(
    RELEASE_SLOT_SCRIPT,
    2,
    GLOBAL_SLOT_KEY,
    lease.userKey,
    lease.token
  );
  const reply = releaseReplySchema.safeParse(rawReply);
  if (!reply.success) throw new Error("Invalid Redis slot release response");
  return reply.data;
}

/** 将 Redis 故障收敛为稳定业务错误，不泄露连接地址或凭据。 */
function unavailableSlotService(error: unknown): Error {
  logWarn("Redis 生图并发槽不可用，已拒绝请求", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return new Error(
    "Image generation concurrency service is unavailable. Please retry shortly."
  );
}

/** 生产入口：从必填 Redis 获取分布式生图并发槽。 */
export async function acquireImageGenerationSlot(input: {
  userId: string;
  globalConcurrency: number;
  userConcurrency: number;
}): Promise<RedisImageGenerationSlotAcquisition> {
  try {
    return await acquireRedisImageGenerationSlot(getRequiredRedisClient(), {
      ...input,
      leaseTtlMs: getImageGenerationSlotLeaseTtlMs(),
    });
  } catch (error) {
    throw unavailableSlotService(error);
  }
}

/** 生产入口：释放当前请求持有的分布式槽位租约。 */
export async function releaseImageGenerationSlot(
  lease: RedisImageGenerationSlotLease
): Promise<void> {
  try {
    await releaseRedisImageGenerationSlot(getRequiredRedisClient(), lease);
  } catch (error) {
    throw unavailableSlotService(error);
  }
}
