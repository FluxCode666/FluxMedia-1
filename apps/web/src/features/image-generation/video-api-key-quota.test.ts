/**
 * 视频 API Key 配额仓储的 DB-free SQL 契约测试。
 *
 * 职责：验证首次预留、崩溃重放、额度不足和重复退款均由任务行锁与持久预留金额收敛。
 */

import { createVideoBillingSnapshot } from "@repo/shared/video-generation/video-billing-snapshot";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { ExternalApiKeyQuotaExceededError } from "@/features/external-api/quota-math";
import {
  createPostgresVideoApiKeyQuotaRepository,
  type VideoApiKeyQuotaDatabase,
  type VideoApiKeyQuotaTransaction,
} from "./video-api-key-quota";

/** 按查询顺序返回脚本化行，并保留生产 SQL 供断言。 */
function createDatabase(resultRows: unknown[][]) {
  const queries: SQL[] = [];
  const database: VideoApiKeyQuotaDatabase = {
    async transaction<T>(
      work: (transaction: VideoApiKeyQuotaTransaction) => Promise<T>
    ): Promise<T> {
      let index = 0;
      return work({
        async execute(query: SQL) {
          queries.push(query);
          const rows = resultRows[index] ?? [];
          index += 1;
          return { rows };
        },
      });
    },
  };
  return { database, queries };
}

describe("video API key quota repository", () => {
  const legacyMetadata = { videoCapabilitySnapshot: { version: 1 } };

  it("首次预留同时增加 key 用量并写入任务金额", async () => {
    const { database, queries } = createDatabase([
      [
        {
          userId: "user-1",
          apiKeyId: "key-1",
          reserved: "0",
          metadata: legacyMetadata,
        },
      ],
      [{ creditLimit: "10", creditsUsed: "4", isActive: true }],
      [{ id: "video-1" }],
    ]);
    const repository = createPostgresVideoApiKeyQuotaRepository(database);

    await expect(
      repository.reserve({ videoId: "video-1", amount: 4 })
    ).resolves.toBe(4);

    const compiled = queries.map(
      (query) => new PgDialect().sqlToQuery(query).sql
    );
    expect(compiled[0]).toContain("for update");
    expect(compiled[1]).toContain("credits_used = credits_used +");
    expect(compiled[2]).toContain("api_key_credits_reserved");
  });

  it("v2 任务只允许预留 metadata 中固定的报价金额", async () => {
    const { database, queries } = createDatabase([
      [
        {
          userId: "user-1",
          apiKeyId: "key-1",
          reserved: "0",
          metadata: {
            videoCapabilitySnapshot: { version: 2 },
            videoBillingSnapshot: createVideoBillingSnapshot({
              quote: {
                modelId: "model-1",
                resolution: "720p",
                mode: "per_item",
                unit: "item",
                unitPrice: 4,
                durationSeconds: 5,
                quotedCredits: 4,
                priceSource: "global_resolution",
              },
              billingGroupId: "group-1",
            }),
          },
        },
      ],
    ]);
    const repository = createPostgresVideoApiKeyQuotaRepository(database);

    await expect(
      repository.reserve({ videoId: "video-1", amount: 5 })
    ).rejects.toThrow("视频任务的 API Key 配额预留金额与固定报价不一致");
    expect(queries).toHaveLength(1);
  });

  it("v2 重放发现任务已预留金额偏离固定报价时拒绝继续", async () => {
    const snapshot = createVideoBillingSnapshot({
      quote: {
        modelId: "model-1",
        resolution: "720p",
        mode: "per_item",
        unit: "item",
        unitPrice: 4,
        durationSeconds: 5,
        quotedCredits: 4,
        priceSource: "global_resolution",
      },
      billingGroupId: "group-1",
    });
    const { database, queries } = createDatabase([
      [
        {
          userId: "user-1",
          apiKeyId: "key-1",
          reserved: "3",
          metadata: {
            videoCapabilitySnapshot: { version: 2 },
            videoBillingSnapshot: snapshot,
          },
        },
      ],
    ]);
    const repository = createPostgresVideoApiKeyQuotaRepository(database);

    await expect(
      repository.reserve({ videoId: "video-1", amount: 4 })
    ).rejects.toThrow("视频任务的 API Key 配额预留金额发生冲突");
    expect(queries).toHaveLength(1);
  });

  it("v1 历史任务继续使用调用方传入的按秒金额", async () => {
    const { database } = createDatabase([
      [
        {
          userId: "user-1",
          apiKeyId: "key-1",
          reserved: "0",
          metadata: {
            ...legacyMetadata,
          },
        },
      ],
      [{ creditLimit: "10", creditsUsed: "4", isActive: true }],
      [{ id: "video-1" }],
    ]);
    const repository = createPostgresVideoApiKeyQuotaRepository(database);

    await expect(
      repository.reserve({ videoId: "video-1", amount: 4 })
    ).resolves.toBe(4);
  });

  it("崩溃重放命中相同任务金额时不再次增加 key 用量", async () => {
    const { database, queries } = createDatabase([
      [
        {
          userId: "user-1",
          apiKeyId: "key-1",
          reserved: "4.00",
          metadata: legacyMetadata,
        },
      ],
    ]);
    const repository = createPostgresVideoApiKeyQuotaRepository(database);

    await expect(
      repository.reserve({ videoId: "video-1", amount: 4 })
    ).resolves.toBe(4);
    expect(queries).toHaveLength(1);
  });

  it("额度不足时保持任务预留为零并返回稳定额度错误", async () => {
    const { database, queries } = createDatabase([
      [
        {
          userId: "user-1",
          apiKeyId: "key-1",
          reserved: "0",
          metadata: legacyMetadata,
        },
      ],
      [],
      [{ creditLimit: "5", creditsUsed: "4", isActive: true }],
    ]);
    const repository = createPostgresVideoApiKeyQuotaRepository(database);

    await expect(
      repository.reserve({ videoId: "video-1", amount: 2 })
    ).rejects.toBeInstanceOf(ExternalApiKeyQuotaExceededError);
    expect(queries).toHaveLength(3);
  });

  it("退款只按任务当前预留金额归还一次", async () => {
    const { database, queries } = createDatabase([
      [
        {
          userId: "user-1",
          apiKeyId: "key-1",
          reserved: "4",
          metadata: legacyMetadata,
        },
      ],
      [{ id: "key-1" }],
      [{ id: "video-1" }],
    ]);
    const repository = createPostgresVideoApiKeyQuotaRepository(database);

    await expect(repository.refund({ videoId: "video-1" })).resolves.toBe(4);
    const compiled = queries.map(
      (query) => new PgDialect().sqlToQuery(query).sql
    );
    expect(compiled[1]).toContain("greatest(0, credits_used -");
    expect(compiled[2]).toContain("api_key_credits_reserved = 0");
  });

  it("重复退款看到零预留时不再更新 key", async () => {
    const { database, queries } = createDatabase([
      [
        {
          userId: "user-1",
          apiKeyId: "key-1",
          reserved: "0",
          metadata: legacyMetadata,
        },
      ],
    ]);
    const repository = createPostgresVideoApiKeyQuotaRepository(database);

    await expect(repository.refund({ videoId: "video-1" })).resolves.toBe(0);
    expect(queries).toHaveLength(1);
  });

  it("Key 已删除时清零任务预留而不毒化退款队列", async () => {
    const { database, queries } = createDatabase([
      [
        {
          userId: "user-1",
          apiKeyId: "deleted-key",
          reserved: "4",
          metadata: legacyMetadata,
        },
      ],
      [],
      [],
      [{ id: "video-1" }],
    ]);
    const repository = createPostgresVideoApiKeyQuotaRepository(database);

    await expect(repository.refund({ videoId: "video-1" })).resolves.toBe(4);
    const compiled = queries.map(
      (query) => new PgDialect().sqlToQuery(query).sql
    );
    expect(compiled[2]).toContain("from external_api_key");
    expect(compiled[3]).toContain("api_key_credits_reserved = 0");
  });
});
