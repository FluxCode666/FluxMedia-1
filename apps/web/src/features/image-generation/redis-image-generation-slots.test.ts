/**
 * Redis 生图并发槽测试。
 *
 * 使用方：Vitest；验证原子脚本调用、用户键隔离、阻塞原因与非法 Redis 响应处理，
 * 不连接真实 Redis。
 */

import { describe, expect, it, vi } from "vitest";

import {
  acquireRedisImageGenerationSlot,
  type RedisImageGenerationSlotClient,
  releaseRedisImageGenerationSlot,
} from "./redis-image-generation-slots";

/** 构造只实现并发槽所需 eval 命令的 Redis 客户端桩。 */
function createClient(reply: unknown): RedisImageGenerationSlotClient {
  return {
    eval: vi.fn(async () => reply),
  };
}

describe("Redis image generation slots", () => {
  it("以全局键和散列用户键原子获取槽位", async () => {
    const client = createClient([1]);

    const result = await acquireRedisImageGenerationSlot(client, {
      userId: "user-a",
      globalConcurrency: 500,
      userConcurrency: 2,
      leaseTtlMs: 60_000,
    });

    expect(result.status).toBe("acquired");
    if (result.status !== "acquired") throw new Error("expected acquisition");
    expect(result.lease.userKey).not.toContain("user-a");
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("ZREMRANGEBYSCORE"),
      2,
      "fluxmedia:v1:image-generation:slots:{image-generation}:global",
      result.lease.userKey,
      result.lease.token,
      500,
      2,
      60_000
    );
  });

  it.each([
    [2, "global"],
    [3, "user"],
  ] as const)("把 Redis 状态码 %s 映射为 %s 阻塞", async (reply, reason) => {
    const client = createClient([reply]);

    await expect(
      acquireRedisImageGenerationSlot(client, {
        userId: "user-a",
        globalConcurrency: 1,
        userConcurrency: 1,
        leaseTtlMs: 60_000,
      })
    ).resolves.toEqual({ status: "blocked", reason });
  });

  it("释放时同时删除全局与用户租约成员", async () => {
    const client = createClient([1]);
    const acquired = await acquireRedisImageGenerationSlot(client, {
      userId: "user-a",
      globalConcurrency: 1,
      userConcurrency: 1,
      leaseTtlMs: 60_000,
    });
    if (acquired.status !== "acquired") throw new Error("expected acquisition");
    const evalMock = vi.mocked(client.eval);
    evalMock.mockResolvedValueOnce(1);

    await releaseRedisImageGenerationSlot(client, acquired.lease);

    expect(evalMock).toHaveBeenLastCalledWith(
      expect.stringContaining("ZREM"),
      2,
      "fluxmedia:v1:image-generation:slots:{image-generation}:global",
      acquired.lease.userKey,
      acquired.lease.token
    );
  });

  it("拒绝无法识别的 Redis 脚本响应", async () => {
    const client = createClient([99]);

    await expect(
      acquireRedisImageGenerationSlot(client, {
        userId: "user-a",
        globalConcurrency: 1,
        userConcurrency: 1,
        leaseTtlMs: 60_000,
      })
    ).rejects.toThrow(/invalid Redis slot response/i);
  });
});
