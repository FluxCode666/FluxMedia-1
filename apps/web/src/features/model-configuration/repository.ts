/**
 * 模型配置的 PostgreSQL 仓储与同事务审计适配器。
 *
 * 保存内核通过本模块初始化并按固定顺序锁定 system_setting、原子写回价格与展示配置，
 * 并用不可伪造的 auditContext 在同一 Drizzle 事务中写 admin_audit_log。本模块只返回
 * unknown 数据库 JSON，严格业务解析仍由 DB-free service-core 负责。
 */
import {
  DEFAULT_VIDEO_MODEL_BILLING_MODES,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
} from "@repo/shared/adobe";
import {
  createDefaultGlobalImageCreditOverrides,
  type GlobalImageCreditOverrides,
} from "@repo/shared/image-backend/group-image-pricing";
import {
  createDefaultModelMarketplaceConfig,
  MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH,
  type ModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import {
  createDefaultVideoModelCapabilityOverrides,
  type VideoModelCapabilityOverrides,
} from "@repo/shared/video-generation";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

import type {
  ModelConfigurationAuditPort,
  ModelConfigurationRepository,
  ModelConfigurationTransaction,
} from "./service-core";

export const MODEL_MARKETPLACE_CONFIG_SETTING_KEY = "MODEL_MARKETPLACE_CONFIG";
export const IMAGE_MODEL_PRICING_SETTING_KEY = "IMAGE_MODEL_CREDIT_PRICES";
export const VIDEO_MODEL_PRICING_SETTING_KEY = "VIDEO_MODEL_CREDITS_PER_SECOND";
export const VIDEO_MODEL_BILLING_MODES_SETTING_KEY =
  "VIDEO_MODEL_BILLING_MODES";
export const VIDEO_MODEL_ITEM_PRICING_SETTING_KEY =
  "VIDEO_MODEL_CREDITS_PER_ITEM";
export const VIDEO_MODEL_CAPABILITY_OVERRIDES_SETTING_KEY =
  "VIDEO_MODEL_CAPABILITY_OVERRIDES";

type ModelConfigurationSettingKey =
  | typeof MODEL_MARKETPLACE_CONFIG_SETTING_KEY
  | typeof IMAGE_MODEL_PRICING_SETTING_KEY
  | typeof VIDEO_MODEL_PRICING_SETTING_KEY
  | typeof VIDEO_MODEL_BILLING_MODES_SETTING_KEY
  | typeof VIDEO_MODEL_ITEM_PRICING_SETTING_KEY
  | typeof VIDEO_MODEL_CAPABILITY_OVERRIDES_SETTING_KEY;

const lockedSettingRowSchema = z.object({ value: z.unknown() });
const mutationRowSchema = z.object({ key: z.string().min(1) });
const auditMutationRowSchema = z.object({ id: z.string().min(1) });
const actorUserIdSchema = z.string().trim().min(1).max(255);
const safeRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const auditEventSchema = z.object({
  id: z.string().trim().min(1).max(255),
  actorUserId: actorUserIdSchema,
  action: z.enum(["model_configuration.update", "model_configuration.delete"]),
  category: z.enum(["image", "video"]),
  configKey: z
    .string()
    .trim()
    .min(1)
    .max(MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH),
  previousRevision: safeRevisionSchema,
  resultingRevision: safeRevisionSchema,
  coverAction: z.enum(["keep", "remove", "replace"]),
  billingMode: z.enum(["per_second", "per_item"]).optional(),
  pricingDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  occurredAt: z.string().datetime({ offset: true }),
});

const DATABASE_AUDIT_CONTEXT_BRAND = Symbol(
  "model-configuration-database-audit-context"
);

/** 生产数据库事务只需支持参数化 Drizzle SQL。 */
export interface ModelConfigurationDatabaseTransaction {
  /** 执行一条带独立参数数组的 Drizzle SQL，并返回不可信驱动结果。 */
  execute(query: SQL): Promise<unknown>;
}

/** 标准 PostgreSQL 与 Neon 共用的最小事务数据库入口。 */
export interface ModelConfigurationDatabase {
  /** 开启且只开启一层数据库事务，并返回回调结果。 */
  transaction<T>(
    work: (transaction: ModelConfigurationDatabaseTransaction) => Promise<T>
  ): Promise<T>;
}

/** 仓储与审计的统一生产适配结果，二者共享同一种事务上下文。 */
export interface DatabaseModelConfigurationPersistence {
  repository: ModelConfigurationRepository;
  audit: ModelConfigurationAuditPort;
}

interface DatabaseAuditContext {
  readonly [DATABASE_AUDIT_CONTEXT_BRAND]: true;
  readonly transaction: ModelConfigurationDatabaseTransaction;
}

/**
 * 将未知 JSON 编码为参数化 PostgreSQL JSON 输入。
 *
 * @param value - 已由服务内核或默认工厂构造的 JSON 值。
 * @returns 不含 SQL 片段的 JSON 文本。
 * @throws Error - undefined、函数或循环引用等不可编码值会显式失败。
 */
function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("模型配置值无法编码为 JSON");
  }
  return serialized;
}

/**
 * 确认 INSERT/UPDATE 的 RETURNING 至少命中一行。
 *
 * @param result - 数据库驱动返回的不可信结果。
 * @param resource - 可安全写入错误消息的资源名称。
 * @throws Error - 加锁资源在事务内异常消失时显式失败并触发回滚。
 */
function assertSettingMutationReturned(
  result: unknown,
  resource: string
): void {
  const rows = z.array(mutationRowSchema).parse(extractExecuteRows(result));
  if (rows.length > 0) return;
  throw new Error(`${resource}在锁定事务中消失`);
}

/**
 * 确认审计 INSERT 的 RETURNING 命中一行。
 *
 * @param result - 数据库驱动返回的不可信结果。
 * @throws Error - 审计未真正落库时显式失败，使配置事务整体回滚。
 */
function assertAuditMutationReturned(result: unknown): void {
  const rows = z
    .array(auditMutationRowSchema)
    .parse(extractExecuteRows(result));
  if (rows.length > 0) return;
  throw new Error("模型配置审计记录未写入");
}

/**
 * 缺行时插入默认值，再用参数化主键谓词锁定并读取设置。
 *
 * @param transaction - 当前唯一数据库事务。
 * @param key - 受支持的固定系统设置键。
 * @param defaultValue - 仅在该键缺失时写入的共享默认值。
 * @returns 数据库 JSON 原样作为 unknown，调用方必须用严格业务 schema 解析。
 * @throws Error - INSERT 后仍找不到主键行时显式失败。
 */
async function initializeAndLockSetting(
  transaction: ModelConfigurationDatabaseTransaction,
  key: ModelConfigurationSettingKey,
  defaultValue: unknown
): Promise<unknown> {
  await transaction.execute(sql`
    insert into system_setting (key, value, is_secret)
    values (${key}, ${serializeJson(defaultValue)}::json, false)
    on conflict (key) do nothing
  `);
  const result = await transaction.execute(sql`
    select value
    from system_setting
    where key = ${key}
    for update
  `);
  const row = extractExecuteRows(result)[0];
  if (!row) {
    throw new Error(`${key} 初始化后仍不存在`);
  }
  return lockedSettingRowSchema.parse(row).value;
}

/**
 * 写回一项已经在当前事务加锁的系统设置。
 *
 * @param transaction - 当前唯一数据库事务。
 * @param key - 与已锁定目标一致的系统设置键。
 * @param value - 已由服务内核严格验证的完整 JSON。
 * @param actorUserId - 最近修改该设置的真实超级管理员 ID。
 * @throws Error - 目标行未命中时触发整个事务回滚。
 */
async function saveLockedSetting(
  transaction: ModelConfigurationDatabaseTransaction,
  key: ModelConfigurationSettingKey,
  value: unknown,
  actorUserId: string
): Promise<void> {
  const parsedActorUserId = actorUserIdSchema.parse(actorUserId);
  const result = await transaction.execute(sql`
    update system_setting
    set value = ${serializeJson(value)}::json,
        is_secret = false,
        updated_by = ${parsedActorUserId},
        updated_at = now()
    where key = ${key}
    returning key
  `);
  assertSettingMutationReturned(result, key);
}

/**
 * 从 unknown 中取得本模块创建的不可伪造事务审计上下文。
 *
 * @param context - service-core 从 transaction.auditContext 原样回传的值。
 * @returns 绑定原 Drizzle 事务的内部上下文。
 * @throws Error - 脱离仓储事务或由调用方伪造时拒绝写审计。
 */
function requireDatabaseAuditContext(context: unknown): DatabaseAuditContext {
  if (!context || typeof context !== "object") {
    throw new Error("模型配置审计上下文无效");
  }
  const candidate = context as {
    [DATABASE_AUDIT_CONTEXT_BRAND]?: unknown;
    transaction?: unknown;
  };
  if (
    candidate[DATABASE_AUDIT_CONTEXT_BRAND] !== true ||
    !candidate.transaction ||
    typeof candidate.transaction !== "object" ||
    !("execute" in candidate.transaction) ||
    typeof candidate.transaction.execute !== "function"
  ) {
    throw new Error("模型配置审计上下文无效");
  }
  return candidate as DatabaseAuditContext;
}

/**
 * 创建绑定单个底层事务的领域事务端口。
 *
 * @param databaseTransaction - 当前 Drizzle 事务的参数化 execute 端口。
 * @returns 强制“展示配置先于唯一目标价格”锁顺序的保存端口。
 */
function createTransactionPort(
  databaseTransaction: ModelConfigurationDatabaseTransaction
): ModelConfigurationTransaction {
  let marketplaceLocked = false;
  let lockedPriceKey:
    | typeof IMAGE_MODEL_PRICING_SETTING_KEY
    | typeof VIDEO_MODEL_PRICING_SETTING_KEY
    | null = null;
  let videoCapabilitiesLocked = false;
  let videoBillingModesLocked = false;
  let videoItemPricingLocked = false;
  const auditContext: DatabaseAuditContext = Object.freeze({
    [DATABASE_AUDIT_CONTEXT_BRAND]: true as const,
    transaction: databaseTransaction,
  });

  /** 在任何价格行之前初始化并锁定模型广场配置。 */
  async function lockMarketplaceConfig(): Promise<unknown> {
    const value = await initializeAndLockSetting(
      databaseTransaction,
      MODEL_MARKETPLACE_CONFIG_SETTING_KEY,
      createDefaultModelMarketplaceConfig()
    );
    marketplaceLocked = true;
    return value;
  }

  /** 初始化并锁定唯一目标价格行，拒绝绕过展示配置锁或同时锁两类价格。 */
  async function lockPriceSetting(
    key:
      | typeof IMAGE_MODEL_PRICING_SETTING_KEY
      | typeof VIDEO_MODEL_PRICING_SETTING_KEY,
    defaultValue: unknown
  ): Promise<unknown> {
    if (!marketplaceLocked) {
      throw new Error("必须先锁定模型广场配置，再锁定目标价格");
    }
    if (lockedPriceKey && lockedPriceKey !== key) {
      throw new Error("一次模型配置事务只能锁定一个目标价格");
    }
    const value = await initializeAndLockSetting(
      databaseTransaction,
      key,
      defaultValue
    );
    lockedPriceKey = key;
    return value;
  }

  /** 确认写入发生在相同目标价格锁之后。 */
  function assertPriceLocked(
    key:
      | typeof IMAGE_MODEL_PRICING_SETTING_KEY
      | typeof VIDEO_MODEL_PRICING_SETTING_KEY,
    label: string
  ): void {
    if (lockedPriceKey !== key) {
      throw new Error(`必须先锁定${label}价格再保存`);
    }
  }

  return {
    auditContext,
    lockMarketplaceConfig,
    async lockImagePricing() {
      return lockPriceSetting(
        IMAGE_MODEL_PRICING_SETTING_KEY,
        createDefaultGlobalImageCreditOverrides()
      );
    },
    async lockVideoPricing() {
      return lockPriceSetting(
        VIDEO_MODEL_PRICING_SETTING_KEY,
        DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND
      );
    },
    async lockVideoBillingModes() {
      if (lockedPriceKey !== VIDEO_MODEL_PRICING_SETTING_KEY) {
        throw new Error("必须先锁定视频每秒价格，再锁定视频计费模式");
      }
      const value = await initializeAndLockSetting(
        databaseTransaction,
        VIDEO_MODEL_BILLING_MODES_SETTING_KEY,
        DEFAULT_VIDEO_MODEL_BILLING_MODES
      );
      videoBillingModesLocked = true;
      return value;
    },
    async lockVideoItemPricing() {
      if (!videoBillingModesLocked) {
        throw new Error("必须先锁定视频计费模式，再锁定视频按条价格");
      }
      const value = await initializeAndLockSetting(
        databaseTransaction,
        VIDEO_MODEL_ITEM_PRICING_SETTING_KEY,
        DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM
      );
      videoItemPricingLocked = true;
      return value;
    },
    async lockVideoCapabilities() {
      if (!videoItemPricingLocked) {
        throw new Error("必须先锁定视频按条价格，再锁定视频能力覆盖");
      }
      const value = await initializeAndLockSetting(
        databaseTransaction,
        VIDEO_MODEL_CAPABILITY_OVERRIDES_SETTING_KEY,
        createDefaultVideoModelCapabilityOverrides()
      );
      videoCapabilitiesLocked = true;
      return value;
    },
    async saveMarketplaceConfig(
      config: ModelMarketplaceConfig,
      actorUserId: string
    ) {
      if (!marketplaceLocked) {
        throw new Error("必须先锁定模型广场配置再保存");
      }
      await saveLockedSetting(
        databaseTransaction,
        MODEL_MARKETPLACE_CONFIG_SETTING_KEY,
        config,
        actorUserId
      );
    },
    async saveImagePricing(
      pricing: GlobalImageCreditOverrides,
      actorUserId: string
    ) {
      assertPriceLocked(IMAGE_MODEL_PRICING_SETTING_KEY, "图像");
      await saveLockedSetting(
        databaseTransaction,
        IMAGE_MODEL_PRICING_SETTING_KEY,
        pricing,
        actorUserId
      );
    },
    async saveVideoPricing(
      pricing: Record<string, number>,
      actorUserId: string
    ) {
      assertPriceLocked(VIDEO_MODEL_PRICING_SETTING_KEY, "视频");
      await saveLockedSetting(
        databaseTransaction,
        VIDEO_MODEL_PRICING_SETTING_KEY,
        pricing,
        actorUserId
      );
    },
    async saveVideoBillingModes(modes, actorUserId) {
      if (!videoBillingModesLocked) {
        throw new Error("必须先锁定视频计费模式再保存");
      }
      await saveLockedSetting(
        databaseTransaction,
        VIDEO_MODEL_BILLING_MODES_SETTING_KEY,
        modes,
        actorUserId
      );
    },
    async saveVideoItemPricing(pricing, actorUserId) {
      if (!videoItemPricingLocked) {
        throw new Error("必须先锁定视频按条价格再保存");
      }
      await saveLockedSetting(
        databaseTransaction,
        VIDEO_MODEL_ITEM_PRICING_SETTING_KEY,
        pricing,
        actorUserId
      );
    },
    async saveVideoCapabilities(
      capabilities: VideoModelCapabilityOverrides,
      actorUserId: string
    ) {
      if (!videoCapabilitiesLocked) {
        throw new Error("必须先锁定视频能力覆盖再保存");
      }
      await saveLockedSetting(
        databaseTransaction,
        VIDEO_MODEL_CAPABILITY_OVERRIDES_SETTING_KEY,
        capabilities,
        actorUserId
      );
    },
  };
}

/**
 * 创建生产可用的模型配置仓储与同事务审计端口。
 *
 * @param database - 可注入的 PostgreSQL/Neon 单事务入口。
 * @returns 必须成对使用的 repository 与 audit；audit 不会开启第二层事务。
 */
export function createDatabaseModelConfigurationRepository(
  database: ModelConfigurationDatabase
): DatabaseModelConfigurationPersistence {
  const repository: ModelConfigurationRepository = {
    async transaction<T>(
      work: (transaction: ModelConfigurationTransaction) => Promise<T>
    ): Promise<T> {
      return database.transaction((databaseTransaction) =>
        work(createTransactionPort(databaseTransaction))
      );
    },
  };

  const audit: ModelConfigurationAuditPort = {
    async record(context, event) {
      const auditContext = requireDatabaseAuditContext(context);
      // Zod 默认剥离运行时附加字段，只把稳定白名单投影到审计表。
      const parsed = auditEventSchema.parse(event);
      const result = await auditContext.transaction.execute(sql`
        insert into admin_audit_log (
          id,
          admin_user_id,
          target_user_id,
          action,
          reason,
          before,
          after,
          metadata,
          created_at
        ) values (
          ${parsed.id},
          ${parsed.actorUserId},
          ${null},
          ${parsed.action},
          ${"模型配置单条目更新"},
          ${serializeJson({ revision: parsed.previousRevision })}::json,
          ${serializeJson({ revision: parsed.resultingRevision })}::json,
          ${serializeJson({
            category: parsed.category,
            configKey: parsed.configKey,
            coverAction: parsed.coverAction,
            ...(parsed.billingMode ? { billingMode: parsed.billingMode } : {}),
            ...(parsed.pricingDigest
              ? { pricingDigest: parsed.pricingDigest }
              : {}),
          })}::json,
          ${new Date(parsed.occurredAt)}
        )
        returning id
      `);
      assertAuditMutationReturned(result);
    },
  };

  return { repository, audit };
}

/**
 * 默认生产仓储；延迟加载数据库可避免 DB-free 测试导入模块时要求 DATABASE_URL。
 */
export const defaultDatabaseModelConfigurationRepository =
  createDatabaseModelConfigurationRepository({
    async transaction<T>(
      work: (transaction: ModelConfigurationDatabaseTransaction) => Promise<T>
    ): Promise<T> {
      const { db } = await import("@repo/database");
      return db.transaction((databaseTransaction) =>
        work({
          execute: (query) => databaseTransaction.execute(query),
        })
      );
    },
  });
