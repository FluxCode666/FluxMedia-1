/**
 * Redis 生图并发槽租约。
 *
 * 使用方：`queue.ts` 与统一生图管线。用户准入槽和全站执行槽由两个独立的 Lua
 * 脚本裁决，并以有界 TTL 自动回收崩溃进程遗留租约；Redis 缺失或故障时失败关闭，
 * 禁止退回进程内计数。
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

const ACQUIRE_ADMISSION_SCRIPT = `
local clock = redis.call("TIME")
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local token = ARGV[1]
local userLimit = tonumber(ARGV[2])
local leaseTtlMs = tonumber(ARGV[3])
local expiresAt = now + leaseTtlMs

local existing = redis.call("ZSCORE", KEYS[1], token)
if existing and tonumber(existing) > now then
  return {1, tonumber(existing)}
end

redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
if redis.call("ZCARD", KEYS[1]) >= userLimit then
  return {2, now}
end

redis.call("ZADD", KEYS[1], expiresAt, token)
redis.call("PEXPIRE", KEYS[1], leaseTtlMs)
return {1, expiresAt}
`;

const ACQUIRE_EXECUTION_SCRIPT = `
local clock = redis.call("TIME")
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local token = ARGV[1]
local globalLimit = tonumber(ARGV[2])
local leaseTtlMs = tonumber(ARGV[3])
local expiresAt = now + leaseTtlMs

local existing = redis.call("ZSCORE", KEYS[1], token)
if existing and tonumber(existing) > now then
  return {1, tonumber(existing)}
end

redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
if redis.call("ZCARD", KEYS[1]) >= globalLimit then
  return {2, now}
end

redis.call("ZADD", KEYS[1], expiresAt, token)
redis.call("PEXPIRE", KEYS[1], leaseTtlMs)
return {1, expiresAt}
`;

const RENEW_LEASE_SCRIPT = `
local clock = redis.call("TIME")
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local token = ARGV[1]
local leaseTtlMs = tonumber(ARGV[2])
local existing = redis.call("ZSCORE", KEYS[1], token)
if not existing or tonumber(existing) <= now then
  redis.call("ZREM", KEYS[1], token)
  return {2, now}
end

local expiresAt = now + leaseTtlMs
redis.call("ZADD", KEYS[1], expiresAt, token)
redis.call("PEXPIRE", KEYS[1], leaseTtlMs)
return {1, expiresAt}
`;

const RELEASE_LEASE_SCRIPT = `
local removed = redis.call("ZREM", KEYS[1], ARGV[1])
if redis.call("ZCARD", KEYS[1]) == 0 then redis.call("DEL", KEYS[1]) end
return removed
`;

const acquireReplySchema = z.union([
  z.tuple([z.literal(1), z.number().int().positive()]),
  z.tuple([z.literal(2), z.number().int().nonnegative()]),
]);
const releaseReplySchema = z.number().int().min(0).max(1);
const renewReplySchema = z.union([
  z.tuple([z.literal(1), z.number().int().positive()]),
  z.tuple([z.literal(2), z.number().int().nonnegative()]),
]);

export type RedisImageGenerationSlotClient = {
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
};

export type RedisImageGenerationAdmissionLease = {
  token: string;
  userKey: string;
  expiresAt: number;
};

export type RedisImageGenerationExecutionLease = {
  token: string;
  expiresAt: number;
};

export type RedisImageGenerationAdmissionAcquisition =
  | { status: "acquired"; lease: RedisImageGenerationAdmissionLease }
  | { status: "blocked"; reason: "user" };

export type RedisImageGenerationExecutionAcquisition =
  | { status: "acquired"; lease: RedisImageGenerationExecutionLease }
  | { status: "blocked"; reason: "global" };

/** 将外部用户 ID 散列为固定长度 Redis key，避免原始标识进入运维键空间。 */
function getUserSlotKey(userId: string): string {
  const digest = createHash("sha256").update(userId).digest("hex");
  return `${USER_SLOT_KEY_PREFIX}${digest}`;
}

/** 从持久 token 和用户身份重建不暴露原始用户 ID 的准入租约。 */
export function restoreImageGenerationAdmissionLease(input: {
  userId: string;
  token: string;
  expiresAt: Date | number;
}): RedisImageGenerationAdmissionLease {
  const expiresAt =
    input.expiresAt instanceof Date
      ? input.expiresAt.getTime()
      : input.expiresAt;
  if (
    !input.token.trim() ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    throw new Error("Invalid persisted image admission lease");
  }
  return {
    token: input.token,
    userKey: getUserSlotKey(input.userId),
    expiresAt,
  };
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
 * 使用 Redis 原子获取一个用户准入槽。
 *
 * @param client 仅暴露 eval 的 Redis 客户端，便于 DB-free 单测。
 * @param input 用户身份、有效并发上限、可重入 token 与崩溃回收 TTL。
 * @returns 成功租约，或明确的用户容量阻塞原因。
 * @throws Redis 返回不受信任的异常形状时失败，不执行本地降级。
 */
export async function acquireRedisImageGenerationAdmission(
  client: RedisImageGenerationSlotClient,
  input: {
    userId: string;
    userConcurrency: number;
    leaseTtlMs: number;
    token?: string;
  }
): Promise<RedisImageGenerationAdmissionAcquisition> {
  const token = input.token ?? randomUUID();
  const userKey = getUserSlotKey(input.userId);
  const rawReply = await client.eval(
    ACQUIRE_ADMISSION_SCRIPT,
    1,
    userKey,
    token,
    input.userConcurrency,
    input.leaseTtlMs
  );
  const reply = acquireReplySchema.safeParse(rawReply);
  if (!reply.success) throw new Error("Invalid Redis admission response");
  if (reply.data[0] === 1) {
    return {
      status: "acquired",
      lease: { token, userKey, expiresAt: reply.data[1] },
    };
  }
  return { status: "blocked", reason: "user" };
}

/** 使用 Redis 原子获取一个全站执行槽；用户准入已在更早阶段完成。 */
export async function acquireRedisImageGenerationExecution(
  client: RedisImageGenerationSlotClient,
  input: {
    globalConcurrency: number;
    leaseTtlMs: number;
    token?: string;
  }
): Promise<RedisImageGenerationExecutionAcquisition> {
  const token = input.token ?? randomUUID();
  const rawReply = await client.eval(
    ACQUIRE_EXECUTION_SCRIPT,
    1,
    GLOBAL_SLOT_KEY,
    token,
    input.globalConcurrency,
    input.leaseTtlMs
  );
  const reply = acquireReplySchema.safeParse(rawReply);
  if (!reply.success) throw new Error("Invalid Redis execution response");
  if (reply.data[0] === 1) {
    return {
      status: "acquired",
      lease: { token, expiresAt: reply.data[1] },
    };
  }
  return { status: "blocked", reason: "global" };
}

/** 仅续期仍存在且未过期的用户准入租约；不会盲目复活丢失 token。 */
export async function renewRedisImageGenerationAdmission(
  client: RedisImageGenerationSlotClient,
  lease: RedisImageGenerationAdmissionLease,
  leaseTtlMs: number
): Promise<{ status: "renewed"; expiresAt: number } | { status: "lost" }> {
  const rawReply = await client.eval(
    RENEW_LEASE_SCRIPT,
    1,
    lease.userKey,
    lease.token,
    leaseTtlMs
  );
  const reply = renewReplySchema.safeParse(rawReply);
  if (!reply.success)
    throw new Error("Invalid Redis admission renewal response");
  return reply.data[0] === 1
    ? { status: "renewed", expiresAt: reply.data[1] }
    : { status: "lost" };
}

/** 仅续期仍存在且未过期的全站执行租约。 */
export async function renewRedisImageGenerationExecution(
  client: RedisImageGenerationSlotClient,
  lease: RedisImageGenerationExecutionLease,
  leaseTtlMs: number
): Promise<{ status: "renewed"; expiresAt: number } | { status: "lost" }> {
  const rawReply = await client.eval(
    RENEW_LEASE_SCRIPT,
    1,
    GLOBAL_SLOT_KEY,
    lease.token,
    leaseTtlMs
  );
  const reply = renewReplySchema.safeParse(rawReply);
  if (!reply.success)
    throw new Error("Invalid Redis execution renewal response");
  return reply.data[0] === 1
    ? { status: "renewed", expiresAt: reply.data[1] }
    : { status: "lost" };
}

/** 释放用户准入租约；重复释放天然幂等。 */
export async function releaseRedisImageGenerationAdmission(
  client: RedisImageGenerationSlotClient,
  lease: RedisImageGenerationAdmissionLease
): Promise<number> {
  return releaseRedisImageGenerationLease(client, lease.userKey, lease.token);
}

/** 释放全站执行租约；重复释放天然幂等。 */
export async function releaseRedisImageGenerationExecution(
  client: RedisImageGenerationSlotClient,
  lease: RedisImageGenerationExecutionLease
): Promise<number> {
  return releaseRedisImageGenerationLease(client, GLOBAL_SLOT_KEY, lease.token);
}

async function releaseRedisImageGenerationLease(
  client: RedisImageGenerationSlotClient,
  key: string,
  token: string
): Promise<number> {
  const rawReply = await client.eval(RELEASE_LEASE_SCRIPT, 1, key, token);
  const reply = releaseReplySchema.safeParse(rawReply);
  if (!reply.success) throw new Error("Invalid Redis lease release response");
  return reply.data;
}

/** 生产入口：从必填 Redis 获取用户准入槽。 */
export async function acquireImageGenerationAdmission(input: {
  userId: string;
  userConcurrency: number;
  token?: string;
}): Promise<RedisImageGenerationAdmissionAcquisition> {
  try {
    return await acquireRedisImageGenerationAdmission(
      getRequiredRedisClient(),
      {
        ...input,
        leaseTtlMs: getImageGenerationSlotLeaseTtlMs(),
      }
    );
  } catch (error) {
    throw unavailableSlotService(error);
  }
}

/** 生产入口：从必填 Redis 获取全站执行槽。 */
export async function acquireImageGenerationExecution(input: {
  globalConcurrency: number;
  token?: string;
}): Promise<RedisImageGenerationExecutionAcquisition> {
  try {
    return await acquireRedisImageGenerationExecution(
      getRequiredRedisClient(),
      {
        ...input,
        leaseTtlMs: getImageGenerationSlotLeaseTtlMs(),
      }
    );
  } catch (error) {
    throw unavailableSlotService(error);
  }
}

/** 生产入口：续期用户准入槽；丢失租约时返回 lost，不盲目复活。 */
export async function renewImageGenerationAdmission(
  lease: RedisImageGenerationAdmissionLease
): Promise<{ status: "renewed"; expiresAt: number } | { status: "lost" }> {
  try {
    return await renewRedisImageGenerationAdmission(
      getRequiredRedisClient(),
      lease,
      getImageGenerationSlotLeaseTtlMs()
    );
  } catch (error) {
    throw unavailableSlotService(error);
  }
}

/** 生产入口：续期全站执行槽。 */
export async function renewImageGenerationExecution(
  lease: RedisImageGenerationExecutionLease
): Promise<{ status: "renewed"; expiresAt: number } | { status: "lost" }> {
  try {
    return await renewRedisImageGenerationExecution(
      getRequiredRedisClient(),
      lease,
      getImageGenerationSlotLeaseTtlMs()
    );
  } catch (error) {
    throw unavailableSlotService(error);
  }
}

/** 生产入口：释放用户准入槽。 */
export async function releaseImageGenerationAdmission(
  lease: RedisImageGenerationAdmissionLease
): Promise<void> {
  try {
    await releaseRedisImageGenerationAdmission(getRequiredRedisClient(), lease);
  } catch (error) {
    throw unavailableSlotService(error);
  }
}

/** 生产入口：释放全站执行槽。 */
export async function releaseImageGenerationExecution(
  lease: RedisImageGenerationExecutionLease
): Promise<void> {
  try {
    await releaseRedisImageGenerationExecution(getRequiredRedisClient(), lease);
  } catch (error) {
    throw unavailableSlotService(error);
  }
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
