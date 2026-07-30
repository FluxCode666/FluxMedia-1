/**
 * 模型配置 PostgreSQL 仓储测试。
 *
 * 使用可注入事务端口和 Drizzle PostgreSQL 方言锁定缺行初始化、固定锁顺序、未知 JSON
 * 边界、原子写入与同事务审计；测试不连接数据库，也不允许敏感附加字段进入审计 SQL。
 */
import { DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND } from "@repo/shared/adobe";
import { createDefaultGlobalImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import { createDefaultModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import { createDefaultVideoModelCapabilityOverrides } from "@repo/shared/video-generation";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  createDatabaseModelConfigurationRepository,
  IMAGE_MODEL_PRICING_SETTING_KEY,
  MODEL_MARKETPLACE_CONFIG_SETTING_KEY,
  type ModelConfigurationDatabase,
  type ModelConfigurationDatabaseTransaction,
  VIDEO_MODEL_CAPABILITY_OVERRIDES_SETTING_KEY,
  VIDEO_MODEL_PRICING_SETTING_KEY,
} from "./repository";
import type { ModelConfigurationAuditEvent } from "./service-core";

const ACTOR_USER_ID = "super-admin-1";
const OCCURRED_AT = "2026-07-26T08:00:00.000Z";

interface CompiledQueryRecord {
  sql: string;
  params: unknown[];
}

/**
 * 把仓储发出的 Drizzle SQL 编译为可断言的 PostgreSQL 文本与参数。
 *
 * @param query - 仓储交给数据库端口的参数化 SQL。
 * @returns 驱动执行前的 SQL 占位符文本和独立参数数组。
 */
function compileQuery(query: SQL): CompiledQueryRecord {
  const compiled = new PgDialect().sqlToQuery(query);
  return { sql: compiled.sql, params: compiled.params };
}

/**
 * 创建按顺序返回结果的单事务数据库桩。
 *
 * @param responses - 每次 execute 依次取得的 node-postgres 或 Neon 风格结果。
 * @returns 可注入数据库、编译查询轨迹和事务调用 spy。
 */
function createDatabase(responses: readonly unknown[]): {
  database: ModelConfigurationDatabase;
  queries: CompiledQueryRecord[];
  transaction: ReturnType<typeof vi.fn>;
} {
  const pendingResponses = [...responses];
  const queries: CompiledQueryRecord[] = [];
  const transaction = vi.fn();
  const database: ModelConfigurationDatabase = {
    async transaction<T>(
      work: (transaction: ModelConfigurationDatabaseTransaction) => Promise<T>
    ): Promise<T> {
      transaction();
      return work({
        async execute(query) {
          queries.push(compileQuery(query));
          return pendingResponses.shift();
        },
      });
    },
  };
  return { database, queries, transaction };
}

/**
 * 构造服务内核写入的最小审计事件。
 *
 * @param overrides - 测试需要覆盖的稳定事件字段。
 * @returns 不含封面字节、存储凭据或原始错误的合法事件。
 */
function createAuditEvent(
  overrides: Partial<ModelConfigurationAuditEvent> = {}
): ModelConfigurationAuditEvent {
  return {
    id: "audit-model-config-1",
    actorUserId: ACTOR_USER_ID,
    action: "model_configuration.update",
    category: "image",
    configKey: "gpt-image-2",
    previousRevision: 2,
    resultingRevision: 3,
    coverAction: "replace",
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

describe("createDatabaseModelConfigurationRepository", () => {
  it("在单次事务中按配置后图像价格的固定顺序初始化、加锁、保存并审计", async () => {
    const dirtyConfigValue = {
      version: 99,
      secretField: "仍作为 unknown 返回",
    };
    const dirtyImagePricingValue = { arbitrary: ["database", "value"] };
    const nextConfig = createDefaultModelMarketplaceConfig();
    const nextImagePricing = createDefaultGlobalImageCreditOverrides();
    const { database, queries, transaction } = createDatabase([
      { rowCount: 1 },
      { rows: [{ value: dirtyConfigValue }] },
      { rowCount: 1 },
      [{ value: dirtyImagePricingValue }],
      { rows: [{ key: IMAGE_MODEL_PRICING_SETTING_KEY }] },
      [{ key: MODEL_MARKETPLACE_CONFIG_SETTING_KEY }],
      { rows: [{ id: "audit-model-config-1" }] },
    ]);
    const persistence = createDatabaseModelConfigurationRepository(database);

    const values = await persistence.repository.transaction(
      async (repositoryTransaction) => {
        const config = await repositoryTransaction.lockMarketplaceConfig();
        const imagePricing = await repositoryTransaction.lockImagePricing();
        await repositoryTransaction.saveImagePricing(
          nextImagePricing,
          ACTOR_USER_ID
        );
        await repositoryTransaction.saveMarketplaceConfig(
          nextConfig,
          ACTOR_USER_ID
        );
        await persistence.audit.record(
          repositoryTransaction.auditContext,
          createAuditEvent()
        );
        return { config, imagePricing };
      }
    );

    expect(values).toEqual({
      config: dirtyConfigValue,
      imagePricing: dirtyImagePricingValue,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queries).toHaveLength(7);

    expect(queries[0]?.sql).toContain("insert into system_setting");
    expect(queries[0]?.sql).toContain("on conflict (key) do nothing");
    expect(queries[0]?.params).toEqual([
      MODEL_MARKETPLACE_CONFIG_SETTING_KEY,
      JSON.stringify(createDefaultModelMarketplaceConfig()),
    ]);
    expect(queries[1]?.sql).toContain("for update");
    expect(queries[1]?.params).toEqual([MODEL_MARKETPLACE_CONFIG_SETTING_KEY]);
    expect(queries[2]?.params).toEqual([
      IMAGE_MODEL_PRICING_SETTING_KEY,
      JSON.stringify(createDefaultGlobalImageCreditOverrides()),
    ]);
    expect(queries[3]?.sql).toContain("for update");
    expect(queries[3]?.params).toEqual([IMAGE_MODEL_PRICING_SETTING_KEY]);

    expect(queries[4]?.sql).toContain("updated_by");
    expect(queries[4]?.sql).toContain("updated_at = now()");
    expect(queries[4]?.params).toEqual([
      JSON.stringify(nextImagePricing),
      ACTOR_USER_ID,
      IMAGE_MODEL_PRICING_SETTING_KEY,
    ]);
    expect(queries[5]?.params).toEqual([
      JSON.stringify(nextConfig),
      ACTOR_USER_ID,
      MODEL_MARKETPLACE_CONFIG_SETTING_KEY,
    ]);

    expect(queries[6]?.sql).toContain("insert into admin_audit_log");
    expect(queries[6]?.params).toEqual(
      expect.arrayContaining([
        "audit-model-config-1",
        ACTOR_USER_ID,
        "model_configuration.update",
        JSON.stringify({ revision: 2 }),
        JSON.stringify({ revision: 3 }),
        JSON.stringify({
          category: "image",
          configKey: "gpt-image-2",
          coverAction: "replace",
        }),
        new Date(OCCURRED_AT),
      ])
    );

    for (const query of queries) {
      expect(query.sql).not.toContain(MODEL_MARKETPLACE_CONFIG_SETTING_KEY);
      expect(query.sql).not.toContain(IMAGE_MODEL_PRICING_SETTING_KEY);
      expect(query.sql).not.toContain(ACTOR_USER_ID);
    }
  });

  it("按配置、视频价格、能力覆盖的固定顺序锁定并读取三项事实", async () => {
    const configValue = createDefaultModelMarketplaceConfig();
    const videoValue = { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND };
    const capabilityValue = createDefaultVideoModelCapabilityOverrides();
    const { database, queries, transaction } = createDatabase([
      { rowCount: 0 },
      [{ value: configValue }],
      { rowCount: 0 },
      { rows: [{ value: videoValue }] },
      { rowCount: 0 },
      { rows: [{ value: capabilityValue }] },
    ]);
    const { repository } = createDatabaseModelConfigurationRepository(database);

    const result = await repository.transaction(
      async (repositoryTransaction) => {
        const config = await repositoryTransaction.lockMarketplaceConfig();
        const videoPricing = await repositoryTransaction.lockVideoPricing();
        const videoCapabilities =
          await repositoryTransaction.lockVideoCapabilities();
        return { config, videoPricing, videoCapabilities };
      }
    );

    expect(result).toEqual({
      config: configValue,
      videoPricing: videoValue,
      videoCapabilities: capabilityValue,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queries.map((query) => query.params[0])).toEqual([
      MODEL_MARKETPLACE_CONFIG_SETTING_KEY,
      MODEL_MARKETPLACE_CONFIG_SETTING_KEY,
      VIDEO_MODEL_PRICING_SETTING_KEY,
      VIDEO_MODEL_PRICING_SETTING_KEY,
      VIDEO_MODEL_CAPABILITY_OVERRIDES_SETTING_KEY,
      VIDEO_MODEL_CAPABILITY_OVERRIDES_SETTING_KEY,
    ]);
    expect(queries[5]?.sql).toContain("for update");
  });

  it("在模型广场配置加锁前拒绝锁价格，且不会执行任何 SQL", async () => {
    const { database, queries } = createDatabase([]);
    const { repository } = createDatabaseModelConfigurationRepository(database);

    await expect(
      repository.transaction((repositoryTransaction) =>
        repositoryTransaction.lockImagePricing()
      )
    ).rejects.toThrow(/必须先锁定模型广场配置/);
    expect(queries).toEqual([]);
  });

  it("缺行初始化后仍读不到设置时显式失败", async () => {
    const { database, queries } = createDatabase([{ rowCount: 1 }, []]);
    const { repository } = createDatabaseModelConfigurationRepository(database);

    await expect(
      repository.transaction((repositoryTransaction) =>
        repositoryTransaction.lockMarketplaceConfig()
      )
    ).rejects.toThrow(/初始化后仍不存在/);
    expect(queries).toHaveLength(2);
  });

  it("只允许在对应价格行加锁后保存，并确认 RETURNING 命中", async () => {
    const { database } = createDatabase([
      { rowCount: 0 },
      [{ value: createDefaultModelMarketplaceConfig() }],
    ]);
    const { repository } = createDatabaseModelConfigurationRepository(database);

    await expect(
      repository.transaction(async (repositoryTransaction) => {
        await repositoryTransaction.lockMarketplaceConfig();
        await repositoryTransaction.saveVideoPricing(
          { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND },
          ACTOR_USER_ID
        );
      })
    ).rejects.toThrow(/必须先锁定视频价格/);
  });

  it("审计只投影白名单字段，不泄漏附加字节、凭据或原始错误", async () => {
    const { database, queries } = createDatabase([
      { rowCount: 0 },
      [{ value: createDefaultModelMarketplaceConfig() }],
      [{ id: "audit-model-config-1" }],
    ]);
    const persistence = createDatabaseModelConfigurationRepository(database);
    const unsafeEvent = {
      ...createAuditEvent(),
      imageBytes: "DO_NOT_LEAK_IMAGE_BYTES",
      storageCredentials: "DO_NOT_LEAK_STORAGE_CREDENTIALS",
      rawError: "DO_NOT_LEAK_RAW_ERROR",
    };

    await persistence.repository.transaction(async (repositoryTransaction) => {
      await repositoryTransaction.lockMarketplaceConfig();
      await persistence.audit.record(
        repositoryTransaction.auditContext,
        unsafeEvent
      );
    });

    const compiledAudit = JSON.stringify(queries[2]);
    expect(compiledAudit).not.toContain("DO_NOT_LEAK_IMAGE_BYTES");
    expect(compiledAudit).not.toContain("DO_NOT_LEAK_STORAGE_CREDENTIALS");
    expect(compiledAudit).not.toContain("DO_NOT_LEAK_RAW_ERROR");
  });

  it("拒绝脱离仓储事务的伪造审计上下文", async () => {
    const { database, queries } = createDatabase([]);
    const { audit } = createDatabaseModelConfigurationRepository(database);

    await expect(audit.record({}, createAuditEvent())).rejects.toThrow(
      /审计上下文无效/
    );
    expect(queries).toEqual([]);
  });
});
