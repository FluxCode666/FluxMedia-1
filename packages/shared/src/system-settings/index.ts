import { db } from "@repo/database";
import { systemSetting } from "@repo/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  globalVideoModelCreditsPerSecondSchema,
  parseVideoModelCreditsPerSecond,
} from "../adobe/video-pricing";
import {
  createDefaultGlobalImageCreditOverrides,
  DEFAULT_IMAGE_CREDIT_PRICING,
  globalImageCreditOverridesSchema,
  imageCreditPricingSchema,
  parseImageCreditOverrides,
} from "../image-backend/group-image-pricing";
import { paginationPageSizeOptionsSchema } from "../pagination/config";
import {
  DEFAULT_SYSTEM_ASSETS_BUCKET_NAME,
  GENERATIONS_BUCKET_SETTING_KEY,
  parseRuntimeStorageBucketConfig,
  SYSTEM_ASSETS_BUCKET_SETTING_KEY,
} from "../storage/bucket-config";
import { PUBLIC_AVATAR_BUCKET_ALIAS } from "../storage/image-url";
import { dashboardSupportConfigSchema } from "../support/dashboard-config";
import {
  clearLocalSystemSettingsCache,
  invalidateSystemSettingsCache,
  loadCachedSystemSettings,
} from "./cache";
import {
  isSettingKey,
  SETTING_DEFINITION_BY_KEY,
  type SettingDefinition,
  type SettingKey,
  SYSTEM_SETTING_DEFINITIONS,
} from "./definitions";
import {
  resolveSiteLogoUrl,
  type SiteBranding,
  siteLogoUrlSchema,
} from "./site-branding";

export { invalidateSystemSettingsCache } from "./cache";
export {
  SETTING_CATEGORIES,
  SETTING_DEFINITION_BY_KEY,
  type SettingCategory,
  type SettingDefinition,
  type SettingKey,
  type SettingValueType,
  SYSTEM_SETTING_DEFINITIONS,
} from "./definitions";
export {
  DEFAULT_SITE_LOGO_URL,
  resolveSiteLogoUrl,
  SITE_LOGO_ROUTE_PATH,
  type SiteBranding,
  siteBrandingSchema,
  siteLogoUrlSchema,
} from "./site-branding";

// WHY：bootstrap 会把 DB 值灌入 process.env 供 Better Auth 等启动期模块使用；
// 运行时设置的 env fallback 必须记住覆盖前的真实部署环境，否则后台清空 DB 行后
// 会错误回退到 bootstrap 注入的旧 DB 值。Map.has 用于区分“尚未覆盖”和“原值为空”。
const PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP = new Map<
  string,
  string | undefined
>();

/** 旧设置键只用于兼容尚未改造的服务端读取方，不再进入后台定义或写入接口。 */
const LEGACY_STORAGE_SETTING_ALIASES = {
  MODEL_MARKETPLACE_ASSETS_BUCKET_NAME: SYSTEM_ASSETS_BUCKET_SETTING_KEY,
  SITE_ASSETS_BUCKET_NAME: SYSTEM_ASSETS_BUCKET_SETTING_KEY,
  NEXT_PUBLIC_AVATARS_BUCKET_NAME: SYSTEM_ASSETS_BUCKET_SETTING_KEY,
  NEXT_PUBLIC_GENERATIONS_BUCKET_NAME: GENERATIONS_BUCKET_SETTING_KEY,
} as const satisfies Partial<Record<SettingKey, SettingKey>>;

/** 把历史只读键解析为当前唯一真相源。 */
function resolveCanonicalSettingKey(key: SettingKey): SettingKey {
  return (
    LEGACY_STORAGE_SETTING_ALIASES[
      key as keyof typeof LEGACY_STORAGE_SETTING_ALIASES
    ] ?? key
  );
}

/**
 * 取得运行时设置的真实部署环境回退值。
 *
 * @param key - 已注册的系统设置键。
 * @returns bootstrap 覆盖前的环境变量；未被覆盖时读取当前环境变量。
 */
function getRuntimeEnvironmentFallback(key: SettingKey) {
  const canonicalKey = resolveCanonicalSettingKey(key);
  if (PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.has(canonicalKey)) {
    return PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.get(canonicalKey);
  }
  return process.env[canonicalKey]?.trim() || undefined;
}

/**
 * 在启动引导阶段把数据库值暴露给只能同步读取 env 的启动期模块。
 *
 * @param key - 数据库中的设置键。
 * @param value - 已序列化的非空设置值。
 * @sideEffects 首次覆盖前保存真实部署 env，并更新当前进程 process.env。
 */
export function setBootstrappedProcessSetting(key: string, value: string) {
  if (!PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.has(key)) {
    PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.set(
      key,
      process.env[key]?.trim() || undefined
    );
  }
  process.env[key] = value;
}

/**
 * 清理启动期 env 覆盖记录，供 DB-free 单测隔离模块状态。
 *
 * @sideEffects 只清空回退元数据，不改写当前 process.env。
 */
export function resetBootstrappedProcessSettingsForTests() {
  PROCESS_SETTING_FALLBACKS_BEFORE_BOOTSTRAP.clear();
}

function normalizeStoredValue(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return value;
}

async function loadSystemSettingsMap() {
  return loadCachedSystemSettings(async () => {
    const rows = await db
      .select({
        key: systemSetting.key,
        value: systemSetting.value,
      })
      .from(systemSetting);

    const values = new Map<string, unknown>();
    for (const row of rows) {
      const normalized = normalizeStoredValue(row.value);
      if (normalized !== undefined) {
        values.set(row.key, normalized);
      }
    }
    return values;
  });
}

export function clearSystemSettingsCache() {
  clearLocalSystemSettingsCache();
}

export async function getSystemSettingValue(
  key: SettingKey
): Promise<unknown | undefined> {
  const values = await loadSystemSettingsMap();
  return values.get(resolveCanonicalSettingKey(key));
}

function parseJsonText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed) as unknown;
}

export async function getRuntimeSettingJson(key: SettingKey) {
  const value = await getSystemSettingValue(key);
  if (value !== undefined) {
    if (typeof value === "string") return parseJsonText(value);
    return value;
  }

  const envValue = getRuntimeEnvironmentFallback(key);
  if (!envValue?.trim()) return undefined;
  return parseJsonText(envValue);
}

export async function getSystemSettingString(key: SettingKey) {
  const value = await getSystemSettingValue(key);
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export async function getRuntimeSettingString(key: SettingKey) {
  const value = await getSystemSettingString(key);
  return value ?? getRuntimeEnvironmentFallback(key);
}

/**
 * 读取并验证全站唯一的系统公共资产桶与用户生成内容桶。
 *
 * @returns 头像、模型封面、网站品牌共用的 systemAssets，以及图片/视频共用的 generations。
 * @sideEffects 并发读取两项运行时系统设置，缓存未命中时会访问数据库或 Redis。
 * @failure 设置非法或两个安全域同名时显式抛出 StorageBucketConfigError。
 */
export async function getRuntimeStorageBucketConfig() {
  const [systemAssets, generations] = await Promise.all([
    getRuntimeSettingString(SYSTEM_ASSETS_BUCKET_SETTING_KEY),
    getRuntimeSettingString(GENERATIONS_BUCKET_SETTING_KEY),
  ]);
  return parseRuntimeStorageBucketConfig(systemAssets, generations);
}

/**
 * 读取当前公开站点品牌配置。
 *
 * @returns 已通过安全契约收窄的 Logo 地址；缺失或脏值回退内置资源。
 * @sideEffects 读取系统设置缓存，缓存未命中时访问数据库。
 * @failure 数据库或缓存基础设施异常保持上抛，由传输层记录并降级。
 */
export async function getSiteBranding(): Promise<SiteBranding> {
  const logoUrl = await getSystemSettingString("SITE_LOGO_URL");
  return { logoUrl: resolveSiteLogoUrl(logoUrl) };
}

/**
 * 通过专用入口保存或恢复网站 Logo。
 *
 * @param logoUrl - 合法 Logo 地址；null 表示删除覆盖并恢复内置资源。
 * @param updatedBy - 已由 UOL 校验的超级管理员用户 ID。
 * @returns 保存后立即生效的公开品牌 DTO。
 * @sideEffects 在数据库事务中写入或删除设置，并失效本地与 Redis 设置缓存。
 * @failure 地址非法、数据库事务或缓存失效失败时保持上抛。
 */
export async function setSiteLogoUrl(
  logoUrl: string | null,
  updatedBy: string
): Promise<SiteBranding> {
  const parsedLogoUrl =
    logoUrl === null ? null : siteLogoUrlSchema.parse(logoUrl);
  const now = new Date();

  await db.transaction(async (tx) => {
    if (parsedLogoUrl === null) {
      await tx
        .delete(systemSetting)
        .where(eq(systemSetting.key, "SITE_LOGO_URL"));
      return;
    }

    await tx
      .insert(systemSetting)
      .values({
        key: "SITE_LOGO_URL",
        value: parsedLogoUrl,
        isSecret: false,
        updatedBy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: {
          value: parsedLogoUrl,
          isSecret: false,
          updatedBy,
          updatedAt: now,
        },
      });
  });

  await invalidateSystemSettingsCache();
  return { logoUrl: parsedLogoUrl ?? resolveSiteLogoUrl(undefined) };
}

export async function getRuntimeSettingBoolean(
  key: SettingKey,
  fallback = false
) {
  const value = await getSystemSettingValue(key);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" && value.trim()) {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  const envValue = getRuntimeEnvironmentFallback(key);
  if (!envValue) return fallback;
  return ["1", "true", "yes", "on"].includes(envValue.toLowerCase());
}

export async function getRuntimeSettingNumber(
  key: SettingKey,
  fallback: number,
  options?: { positive?: boolean; nonNegative?: boolean }
) {
  const isAllowedNumber = (candidate: number) => {
    if (!Number.isFinite(candidate)) return false;
    if (options?.positive) return candidate > 0;
    if (options?.nonNegative) return candidate >= 0;
    return true;
  };
  const value = await getSystemSettingValue(key);
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (isAllowedNumber(numericValue)) {
    return numericValue;
  }

  const envRawValue = getRuntimeEnvironmentFallback(key);
  if (envRawValue) {
    const envValue = Number(envRawValue);
    if (isAllowedNumber(envValue)) {
      return envValue;
    }
  }

  return fallback;
}

export async function getRuntimeSettingSelect<T extends string>(
  key: SettingKey,
  allowed: readonly T[],
  fallback: T
) {
  const value = await getRuntimeSettingString(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function getProcessSettingString(key: SettingKey) {
  return process.env[resolveCanonicalSettingKey(key)]?.trim() || undefined;
}

export function getProcessSettingBoolean(key: SettingKey, fallback = false) {
  const value = process.env[resolveCanonicalSettingKey(key)];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function getProcessSettingNumber(key: SettingKey, fallback: number) {
  const value = Number(process.env[resolveCanonicalSettingKey(key)]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function coerceValue(definition: SettingDefinition, value: unknown) {
  if (definition.valueType === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    }
    return Boolean(value);
  }

  if (definition.valueType === "number") {
    // WHY: 空白数值输入视为清空（删除行，回退默认值），与 string 类型一致；
    // 否则 Number("") === 0 会被范围校验误判，破坏"清空即重置"的后台 UX。
    if (typeof value === "string" && !value.trim()) {
      return "";
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`${definition.label} 必须是有效数字`);
    }
    if (definition.integer && !Number.isSafeInteger(numeric)) {
      throw new Error(`${definition.label} 必须是整数`);
    }
    // WHY: 经济/安全语义键（积分、价格、审核超时等）在 definitions.ts 声明了业务
    // 上下界；S-C1 已把写入收紧为 superAdminAction，此处补 per-key 范围闭区间钳制，
    // 拒绝负积分/负价格/0 超时/异常巨大值等会破坏经济或安全语义的脏值落库。
    // 未声明 min/max 的键行为不变。
    if (definition.min !== undefined && numeric < definition.min) {
      throw new Error(`${definition.label} 不能小于 ${definition.min}`);
    }
    if (definition.max !== undefined && numeric > definition.max) {
      throw new Error(`${definition.label} 不能大于 ${definition.max}`);
    }
    return numeric;
  }

  if (definition.valueType === "json") {
    if (value === undefined || value === null) return "";
    let parsedValue: unknown = value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return "";
      try {
        parsedValue = JSON.parse(trimmed) as unknown;
      } catch {
        throw new Error(`${definition.label} 必须是有效 JSON`);
      }
    }
    if (definition.key === "DASHBOARD_SUPPORT_CONFIG") {
      const parsed = dashboardSupportConfigSchema.safeParse(parsedValue);
      if (!parsed.success) {
        throw new Error(`${definition.label} 的字段或链接格式无效`);
      }
      return parsed.data;
    }
    if (definition.key === "PAGINATION_PAGE_SIZE_OPTIONS") {
      const parsed = paginationPageSizeOptionsSchema.safeParse(parsedValue);
      if (!parsed.success) {
        throw new Error(
          `${definition.label} 必须是包含 20 的不重复整数数组，且每项位于 1 至 100`
        );
      }
      return parsed.data;
    }
    return parsedValue;
  }

  const text = typeof value === "string" ? value.trim() : String(value ?? "");
  if (
    text === PUBLIC_AVATAR_BUCKET_ALIAS &&
    (definition.key === SYSTEM_ASSETS_BUCKET_SETTING_KEY ||
      definition.key === GENERATIONS_BUCKET_SETTING_KEY)
  ) {
    // 逻辑别名由读取 Route 解释，不能成为真实存储目标；否则本地存储可形成自重定向。
    throw new Error(`${definition.label} 不能使用系统保留名称`);
  }
  if (definition.key === "SITE_LOGO_URL" && text) {
    const parsed = siteLogoUrlSchema.safeParse(text);
    if (!parsed.success) {
      throw new Error(
        `${definition.label}仅支持站内根路径或不含账号凭据的 HTTPS 地址`
      );
    }
    return parsed.data;
  }
  if (definition.valueType === "select") {
    const allowed = definition.options?.map((option) => option.value) ?? [];
    if (text && !allowed.includes(text)) {
      throw new Error(`${definition.label} 的取值无效`);
    }
  }
  return text;
}

function getProcessSettingValue(definition: SettingDefinition) {
  const envValue = getRuntimeEnvironmentFallback(definition.key);
  if (!envValue) return undefined;
  return coerceValue(definition, envValue);
}

function getDefaultSettingValue(definition: SettingDefinition) {
  if (definition.secret) return undefined;
  if (definition.exampleValue !== undefined) return definition.exampleValue;
  if (definition.defaultValue !== undefined) return definition.defaultValue;
  return undefined;
}

export async function importSystemSettingsFromEnv(options?: {
  updatedBy?: string;
  overwrite?: boolean;
}) {
  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
    })
    .from(systemSetting);

  const storedKeys = new Set(
    rows
      .filter((row) => normalizeStoredValue(row.value) !== undefined)
      .map((row) => row.key)
  );
  const now = new Date();
  const values = SYSTEM_SETTING_DEFINITIONS.flatMap((definition) => {
    if (
      "managedByDedicatedOperation" in definition &&
      definition.managedByDedicatedOperation
    ) {
      return [];
    }
    if (!options?.overwrite && storedKeys.has(definition.key)) return [];

    const value = getProcessSettingValue(definition);
    if (value === undefined || value === "") return [];

    return [
      {
        key: definition.key,
        value,
        isSecret: "secret" in definition && Boolean(definition.secret),
        ...(options?.updatedBy ? { updatedBy: options.updatedBy } : {}),
        updatedAt: now,
      },
    ];
  });

  if (values.length === 0) return [] as SettingKey[];

  await db
    .insert(systemSetting)
    .values(values)
    .onConflictDoUpdate({
      target: systemSetting.key,
      set: {
        value: sql`excluded.value`,
        isSecret: sql`excluded.is_secret`,
        updatedBy: sql`excluded.updated_by`,
        updatedAt: now,
      },
    });

  await invalidateSystemSettingsCache();

  return values.map((value) => value.key);
}

export async function initializeMissingSystemSettingsDefaults(options?: {
  updatedBy?: string;
}) {
  const now = new Date();
  await migrateLegacyStorageBucketSettings(now, options?.updatedBy);
  await migrateLegacyModerationSettings(now, options?.updatedBy);
  await migrateLegacyVideoModelPricing(now, options?.updatedBy);
  await migrateLegacyGlobalModelPricing(now, options?.updatedBy);

  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
    })
    .from(systemSetting);

  const storedKeys = new Set(
    rows
      .filter((row) => normalizeStoredValue(row.value) !== undefined)
      .map((row) => row.key)
  );
  const values = SYSTEM_SETTING_DEFINITIONS.flatMap((definition) => {
    if (storedKeys.has(definition.key)) return [];

    const value = getDefaultSettingValue(definition);
    if (value === undefined || value === "") return [];

    return [
      {
        key: definition.key,
        value,
        isSecret: false,
        ...(options?.updatedBy ? { updatedBy: options.updatedBy } : {}),
        updatedAt: now,
      },
    ];
  });

  if (values.length === 0) return [] as SettingKey[];

  await db.insert(systemSetting).values(values).onConflictDoNothing({
    target: systemSetting.key,
  });

  await invalidateSystemSettingsCache();
  return values.map((value) => value.key);
}

/**
 * 把历史四项资产桶设置收敛为两个运行时真相源。
 *
 * WHY：旧版把头像、模型封面、网站品牌拆成三个设置，并用 NEXT_PUBLIC 生成桶触发
 * 构建期内联。迁移只在新键缺失时复制可确定的部署意图；不删除旧键，保留快速回滚
 * 能力，也不迁移旧对象。三项公开桶冲突时采用新的稳定 system 默认值。
 *
 * @param now - 本次迁移统一使用的更新时间。
 * @param updatedBy - 可选的管理员用户 ID。
 * @returns 无返回值；没有历史设置或新键已存在时不写数据库。
 * @sideEffects 可能插入 SYSTEM_ASSETS_BUCKET_NAME、GENERATIONS_BUCKET_NAME 并失效缓存。
 * @failure 数据库事务或缓存失效失败时保持上抛。
 */
async function migrateLegacyStorageBucketSettings(
  now: Date,
  updatedBy?: string
) {
  const legacySystemKeys = [
    "MODEL_MARKETPLACE_ASSETS_BUCKET_NAME",
    "SITE_ASSETS_BUCKET_NAME",
    "NEXT_PUBLIC_AVATARS_BUCKET_NAME",
  ] as const;
  const legacyGenerationsKey = "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME";
  const rows = await db
    .select({ key: systemSetting.key, value: systemSetting.value })
    .from(systemSetting)
    .where(
      inArray(systemSetting.key, [
        SYSTEM_ASSETS_BUCKET_SETTING_KEY,
        GENERATIONS_BUCKET_SETTING_KEY,
        ...legacySystemKeys,
        legacyGenerationsKey,
      ])
    );
  const stored = new Map(
    rows
      .map((row) => [row.key, normalizeStoredValue(row.value)] as const)
      .filter(([, value]) => value !== undefined)
  );
  const values: Array<{
    key: SettingKey;
    value: string;
    isSecret: false;
    updatedBy?: string;
    updatedAt: Date;
  }> = [];

  if (!stored.has(SYSTEM_ASSETS_BUCKET_SETTING_KEY)) {
    const legacySystemBuckets = legacySystemKeys.flatMap((key) => {
      const value = stored.get(key);
      return typeof value === "string" && value.trim() ? [value.trim()] : [];
    });
    if (legacySystemBuckets.length > 0) {
      const sharedBucket = legacySystemBuckets.find(
        (bucket, index) => legacySystemBuckets.indexOf(bucket) !== index
      );
      values.push({
        key: SYSTEM_ASSETS_BUCKET_SETTING_KEY,
        value: sharedBucket ?? DEFAULT_SYSTEM_ASSETS_BUCKET_NAME,
        isSecret: false,
        ...(updatedBy ? { updatedBy } : {}),
        updatedAt: now,
      });
    }
  }

  if (!stored.has(GENERATIONS_BUCKET_SETTING_KEY)) {
    const legacyGenerations = stored.get(legacyGenerationsKey);
    if (typeof legacyGenerations === "string" && legacyGenerations.trim()) {
      values.push({
        key: GENERATIONS_BUCKET_SETTING_KEY,
        value: legacyGenerations.trim(),
        isSecret: false,
        ...(updatedBy ? { updatedBy } : {}),
        updatedAt: now,
      });
    }
  }

  if (values.length === 0) return;
  await db.insert(systemSetting).values(values).onConflictDoNothing({
    target: systemSetting.key,
  });
  await invalidateSystemSettingsCache();
}

/**
 * 将旧的“通用每秒价 × 模型倍率”配置迁移为每模型固定每秒价格。
 *
 * @param now - 本次迁移统一使用的更新时间。
 * @param updatedBy - 可选的管理员用户 ID。
 * @returns 无返回值；新键已存在时只删除旧倍率键，不覆盖管理员的新价格。
 */
async function migrateLegacyVideoModelPricing(now: Date, updatedBy?: string) {
  const legacyKey = "VIDEO_MODEL_MULTIPLIERS";
  const targetKey = "VIDEO_MODEL_CREDITS_PER_SECOND";
  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
    })
    .from(systemSetting)
    .where(
      inArray(systemSetting.key, [
        "VIDEO_BASE_CREDITS_PER_SECOND",
        legacyKey,
        targetKey,
      ])
    );
  const stored = new Map(
    rows
      .map((row) => [row.key, normalizeStoredValue(row.value)] as const)
      .filter(([, value]) => value !== undefined)
  );
  if (!stored.has(legacyKey)) return;

  const rawBasePrice = stored.get("VIDEO_BASE_CREDITS_PER_SECOND");
  const basePrice =
    typeof rawBasePrice === "number" &&
    Number.isFinite(rawBasePrice) &&
    rawBasePrice > 0
      ? rawBasePrice
      : 30;
  const rawMultipliers = stored.get(legacyKey);
  const perSecondPrices: Record<string, number> = {};
  if (
    rawMultipliers &&
    typeof rawMultipliers === "object" &&
    !Array.isArray(rawMultipliers)
  ) {
    for (const [family, rawMultiplier] of Object.entries(rawMultipliers)) {
      if (
        typeof rawMultiplier === "number" &&
        Number.isFinite(rawMultiplier) &&
        rawMultiplier > 0
      ) {
        perSecondPrices[family] = basePrice * rawMultiplier;
      }
    }
  }

  await db.transaction(async (tx) => {
    if (!stored.has(targetKey)) {
      await tx
        .insert(systemSetting)
        .values({
          key: targetKey,
          value: perSecondPrices,
          isSecret: false,
          ...(updatedBy ? { updatedBy } : {}),
          updatedAt: now,
        })
        .onConflictDoNothing({ target: systemSetting.key });
    }
    await tx
      .delete(systemSetting)
      .where(inArray(systemSetting.key, [legacyKey]));
  });
  await invalidateSystemSettingsCache();
}

/**
 * 把历史稀疏模型价格补齐为全局必填矩阵。
 *
 * 旧版允许图像价格逐档缺失、视频模型族缺失并回退到通用基价。新规则只允许分组与全局
 * 两层显式定价，因此迁移将历史显式值保留，并用原通用档位或开发默认值补齐缺失价格。
 * 视频仅含 family 的旧配置由价格 schema 在读取时补齐分辨率，不触发重复持久化。
 */
async function migrateLegacyGlobalModelPricing(now: Date, updatedBy?: string) {
  const imageKey = "IMAGE_MODEL_CREDIT_PRICES";
  const videoKey = "VIDEO_MODEL_CREDITS_PER_SECOND";
  const imageBaseKeys = [
    "IMAGE_BASE_CREDITS_1024",
    "IMAGE_BASE_CREDITS_1K",
    "IMAGE_BASE_CREDITS_2K",
    "IMAGE_BASE_CREDITS_4K",
  ];
  const videoBaseKey = "VIDEO_BASE_CREDITS_PER_SECOND";
  const rows = await db
    .select({ key: systemSetting.key, value: systemSetting.value })
    .from(systemSetting)
    .where(
      inArray(systemSetting.key, [
        imageKey,
        videoKey,
        videoBaseKey,
        ...imageBaseKeys,
      ])
    );
  const stored = new Map(
    rows
      .map((row) => [row.key, normalizeStoredValue(row.value)] as const)
      .filter(([, value]) => value !== undefined)
  );
  const imageRaw = stored.get(imageKey);
  const videoRaw = stored.get(videoKey);
  const legacyImagePricingByModel =
    imageRaw && typeof imageRaw === "object" && "byModel" in imageRaw
      ? imageRaw.byModel
      : null;
  const legacyDefaultPricingValue =
    legacyImagePricingByModel && typeof legacyImagePricingByModel === "object"
      ? Object.entries(legacyImagePricingByModel).find(
          ([model]) => model.trim().toLowerCase() === "default"
        )?.[1]
      : undefined;
  const legacyDefaultPricingResult =
    legacyDefaultPricingValue !== undefined
      ? imageCreditPricingSchema.safeParse(legacyDefaultPricingValue)
      : null;
  const legacyDefaultPricing = legacyDefaultPricingResult?.success
    ? legacyDefaultPricingResult.data
    : null;
  const hasLegacyDefaultPricing = legacyImagePricingByModel
    ? Object.keys(legacyImagePricingByModel).some(
        (model) => model.trim().toLowerCase() === "default"
      )
    : false;
  const imageNeedsMigration =
    imageRaw !== undefined &&
    (hasLegacyDefaultPricing ||
      !globalImageCreditOverridesSchema.safeParse(imageRaw).success);
  const videoNeedsMigration =
    videoRaw !== undefined &&
    !globalVideoModelCreditsPerSecondSchema.safeParse(videoRaw).success;
  if (!imageNeedsMigration && !videoNeedsMigration) return;

  const readPositive = (key: string, fallback: number) => {
    const value = stored.get(key);
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  };
  const imageFallback = {
    base1024Credits:
      legacyDefaultPricing?.base1024Credits ??
      readPositive(
        "IMAGE_BASE_CREDITS_1024",
        DEFAULT_IMAGE_CREDIT_PRICING.base1024Credits
      ),
    base1kCredits:
      legacyDefaultPricing?.base1kCredits ??
      readPositive(
        "IMAGE_BASE_CREDITS_1K",
        DEFAULT_IMAGE_CREDIT_PRICING.base1kCredits
      ),
    base2kCredits:
      legacyDefaultPricing?.base2kCredits ??
      readPositive(
        "IMAGE_BASE_CREDITS_2K",
        DEFAULT_IMAGE_CREDIT_PRICING.base2kCredits
      ),
    base4kCredits:
      legacyDefaultPricing?.base4kCredits ??
      readPositive(
        "IMAGE_BASE_CREDITS_4K",
        DEFAULT_IMAGE_CREDIT_PRICING.base4kCredits
      ),
  };
  const image = createDefaultGlobalImageCreditOverrides();
  for (const model of Object.keys(image.byModel)) {
    image.byModel[model] = { ...imageFallback };
  }
  for (const [model, pricing] of Object.entries(
    parseImageCreditOverrides(imageRaw).byModel
  )) {
    image.byModel[model] = {
      base1024Credits: pricing.base1024Credits ?? imageFallback.base1024Credits,
      base1kCredits: pricing.base1kCredits ?? imageFallback.base1kCredits,
      base2kCredits: pricing.base2kCredits ?? imageFallback.base2kCredits,
      base4kCredits: pricing.base4kCredits ?? imageFallback.base4kCredits,
    };
  }
  const videoBase = readPositive(
    videoBaseKey,
    DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND.sora2 ?? 30
  );
  const video = {
    ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
    ...Object.fromEntries(
      Object.keys(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND).map((family) => [
        family,
        videoBase,
      ])
    ),
    ...parseVideoModelCreditsPerSecond(videoRaw),
  };

  await db.transaction(async (tx) => {
    if (imageNeedsMigration) {
      await tx
        .insert(systemSetting)
        .values({
          key: imageKey,
          value: image,
          isSecret: false,
          ...(updatedBy ? { updatedBy } : {}),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: systemSetting.key,
          set: {
            value: image,
            ...(updatedBy ? { updatedBy } : {}),
            updatedAt: now,
          },
        });
    }
    if (videoNeedsMigration) {
      await tx
        .insert(systemSetting)
        .values({
          key: videoKey,
          value: video,
          isSecret: false,
          ...(updatedBy ? { updatedBy } : {}),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: systemSetting.key,
          set: {
            value: video,
            ...(updatedBy ? { updatedBy } : {}),
            updatedAt: now,
          },
        });
    }
  });
  await invalidateSystemSettingsCache();
}

async function migrateLegacyModerationSettings(now: Date, updatedBy?: string) {
  const legacyKeys = [
    "ALIYUN_MODERATION_PUBLIC_BASE_URL",
    "ALIYUN_MODERATION_BLOCK_RISK_LEVEL",
  ];
  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
    })
    .from(systemSetting)
    .where(
      inArray(systemSetting.key, [
        "CONTENT_MODERATION_PUBLIC_BASE_URL",
        ...legacyKeys,
      ])
    );

  const stored = new Map(
    rows
      .map((row) => [row.key, normalizeStoredValue(row.value)] as const)
      .filter(([, value]) => value !== undefined)
  );
  const legacyPublicBaseUrl = stored.get("ALIYUN_MODERATION_PUBLIC_BASE_URL");
  const hasPublicBaseUrl = stored.has("CONTENT_MODERATION_PUBLIC_BASE_URL");

  await db.transaction(async (tx) => {
    if (!hasPublicBaseUrl && legacyPublicBaseUrl !== undefined) {
      await tx
        .insert(systemSetting)
        .values({
          key: "CONTENT_MODERATION_PUBLIC_BASE_URL",
          value: legacyPublicBaseUrl,
          isSecret: false,
          ...(updatedBy ? { updatedBy } : {}),
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: systemSetting.key,
        });
    }

    await tx
      .delete(systemSetting)
      .where(inArray(systemSetting.key, legacyKeys));
  });

  await invalidateSystemSettingsCache();
}

export async function importMissingSystemSettingsFromEnv(updatedBy?: string) {
  return importSystemSettingsFromEnv(
    updatedBy === undefined ? undefined : { updatedBy }
  );
}

export async function setSystemSettings(
  entries: Array<{
    key: string;
    value: unknown;
    clear?: boolean;
  }>,
  updatedBy: string
) {
  const now = new Date();
  const changedKeys: SettingKey[] = [];

  await db.transaction(async (tx) => {
    for (const entry of entries) {
      if (!isSettingKey(entry.key)) {
        throw new Error(`未知配置项: ${entry.key}`);
      }

      const definition = SETTING_DEFINITION_BY_KEY.get(entry.key);
      if (!definition) {
        throw new Error(`未知配置项: ${entry.key}`);
      }

      if (definition.managedByDedicatedOperation) {
        throw new Error(`${definition.label}只能通过专用配置入口修改`);
      }

      if (entry.clear) {
        await tx.delete(systemSetting).where(eq(systemSetting.key, entry.key));
        changedKeys.push(entry.key);
        continue;
      }

      if (
        definition.secret &&
        typeof entry.value === "string" &&
        !entry.value.trim()
      ) {
        continue;
      }

      const value = coerceValue(definition, entry.value);
      if (value === "") {
        await tx.delete(systemSetting).where(eq(systemSetting.key, entry.key));
      } else {
        await tx
          .insert(systemSetting)
          .values({
            key: entry.key,
            value,
            isSecret: Boolean(definition.secret),
            updatedBy,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: systemSetting.key,
            set: {
              value,
              isSecret: Boolean(definition.secret),
              updatedBy,
              updatedAt: now,
            },
          });
      }
      changedKeys.push(entry.key);
    }
  });

  await invalidateSystemSettingsCache();
  return changedKeys;
}

export async function getAdminSystemSettingsSnapshot() {
  const keys = SYSTEM_SETTING_DEFINITIONS.map((definition) => definition.key);
  const rows = await db
    .select({
      key: systemSetting.key,
      value: systemSetting.value,
      isSecret: systemSetting.isSecret,
      updatedAt: systemSetting.updatedAt,
    })
    .from(systemSetting)
    .where(inArray(systemSetting.key, keys));

  const stored = new Map(rows.map((row) => [row.key, row]));

  return SYSTEM_SETTING_DEFINITIONS.map((definition) => {
    const row = stored.get(definition.key);
    const envValue =
      "managedByDedicatedOperation" in definition &&
      definition.managedByDedicatedOperation
        ? undefined
        : getRuntimeEnvironmentFallback(definition.key);
    const hasStoredValue =
      row?.value !== undefined &&
      row.value !== null &&
      (typeof row.value !== "string" || row.value.trim().length > 0);
    const hasEnvValue =
      typeof envValue === "string" && envValue.trim().length > 0;
    const isSecret = "secret" in definition && Boolean(definition.secret);
    const displayValue = isSecret
      ? ""
      : hasStoredValue
        ? typeof row.value === "object"
          ? JSON.stringify(row.value, null, 2)
          : String(row.value)
        : hasEnvValue
          ? envValue.trim()
          : "";

    return {
      ...definition,
      value: displayValue,
      configured: hasStoredValue || hasEnvValue,
      stored: hasStoredValue,
      fromEnv: !hasStoredValue && hasEnvValue,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  });
}
