/**
 * Redis 生图并发槽测试。
 *
 * 使用方：Vitest；验证用户准入与全站执行租约相互独立、租约续期不会复活丢失
 * token、用户键不泄露原始 ID，以及非法 Redis 响应始终失败关闭。
 */

import { describe, expect, it, vi } from "vitest";

import {
  acquireRedisImageGenerationAdmission,
  acquireRedisImageGenerationExecution,
  type RedisImageGenerationSlotClient,
  releaseRedisImageGenerationAdmission,
  releaseRedisImageGenerationExecution,
  renewRedisImageGenerationAdmission,
} from "./redis-image-generation-slots";

/** 构造只实现并发槽所需 eval 命令的 Redis 客户端桩。 */
function createClient(reply: unknown): RedisImageGenerationSlotClient {
  return {
    eval: vi.fn(async () => reply),
  };
}

describe("Redis image generation slots", () => {
  it("以散列用户键取得独立准入租约并返回 Redis 服务端 expiry", async () => {
    const client = createClient([1, 1_700_000_060_000]);

    const result = await acquireRedisImageGenerationAdmission(client, {
      userId: "user-a",
      userConcurrency: 20,
      leaseTtlMs: 60_000,
      token: "admission-token",
    });

    expect(result.status).toBe("acquired");
    if (result.status !== "acquired") throw new Error("expected acquisition");
    expect(result.lease.userKey).not.toContain("user-a");
    expect(result.lease.expiresAt).toBe(1_700_000_060_000);
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("ZCARD"),
      1,
      result.lease.userKey,
      "admission-token",
      20,
      60_000
    );
  });

  it("用户槽已满时立即返回 user 阻塞且不请求全站槽", async () => {
    const client = createClient([2, 1_700_000_000_000]);

    await expect(
      acquireRedisImageGenerationAdmission(client, {
        userId: "user-a",
        userConcurrency: 1,
        leaseTtlMs: 60_000,
      })
    ).resolves.toEqual({ status: "blocked", reason: "user" });
    expect(client.eval).toHaveBeenCalledTimes(1);
  });

  it("全站执行槽只使用全局键且容量不足时返回 global 阻塞", async () => {
    const acquiredClient = createClient([1, 1_700_000_060_000]);
    const acquired = await acquireRedisImageGenerationExecution(
      acquiredClient,
      {
        globalConcurrency: 500,
        leaseTtlMs: 60_000,
        token: "execution-token",
      }
    );

    expect(acquired).toEqual({
      status: "acquired",
      lease: {
        token: "execution-token",
        expiresAt: 1_700_000_060_000,
      },
    });
    expect(acquiredClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("globalLimit"),
      1,
      "fluxmedia:v1:image-generation:slots:{image-generation}:global",
      "execution-token",
      500,
      60_000
    );

    const blockedClient = createClient([2, 1_700_000_000_000]);
    await expect(
      acquireRedisImageGenerationExecution(blockedClient, {
        globalConcurrency: 500,
        leaseTtlMs: 60_000,
      })
    ).resolves.toEqual({ status: "blocked", reason: "global" });
  });

  it("准入续期只延长仍存在的 token，丢失时不执行 ZADD 复活", async () => {
    const renewedClient = createClient([1, 1_700_000_120_000]);
    const lease = {
      token: "admission-token",
      userKey: "hashed-user-key",
      expiresAt: 1_700_000_060_000,
    };

    await expect(
      renewRedisImageGenerationAdmission(renewedClient, lease, 60_000)
    ).resolves.toEqual({
      status: "renewed",
      expiresAt: 1_700_000_120_000,
    });
    expect(renewedClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("if not existing or tonumber(existing) <= now"),
      1,
      lease.userKey,
      lease.token,
      60_000
    );

    const lostClient = createClient([2, 1_700_000_060_000]);
    await expect(
      renewRedisImageGenerationAdmission(lostClient, lease, 60_000)
    ).resolves.toEqual({ status: "lost" });
  });

  it("用户准入和全站执行租约分别释放且重复释放天然幂等", async () => {
    const admissionClient = createClient(1);
    await expect(
      releaseRedisImageGenerationAdmission(admissionClient, {
        token: "admission-token",
        userKey: "hashed-user-key",
        expiresAt: 1_700_000_060_000,
      })
    ).resolves.toBe(1);
    expect(admissionClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("ZREM"),
      1,
      "hashed-user-key",
      "admission-token"
    );

    const executionClient = createClient(0);
    await expect(
      releaseRedisImageGenerationExecution(executionClient, {
        token: "execution-token",
        expiresAt: 1_700_000_060_000,
      })
    ).resolves.toBe(0);
    expect(executionClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("ZREM"),
      1,
      "fluxmedia:v1:image-generation:slots:{image-generation}:global",
      "execution-token"
    );
  });

  it("拒绝无法识别的 Redis 脚本响应", async () => {
    const client = createClient([99]);

    await expect(
      acquireRedisImageGenerationAdmission(client, {
        userId: "user-a",
        userConcurrency: 1,
        leaseTtlMs: 60_000,
      })
    ).rejects.toThrow(/invalid Redis admission response/i);
  });
});
