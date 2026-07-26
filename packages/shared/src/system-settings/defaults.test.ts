import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND } from "../adobe/video-pricing";
import {
  CREDIT_PACKAGE_MATRIX_SETTING_KEY,
  getRuntimeCreditPackages,
} from "../credits/packages";
import { createDefaultGlobalImageCreditOverrides } from "../image-backend/group-image-pricing";
import { createDefaultModelMarketplaceConfig } from "../model-marketplace";
import { DEFAULT_PLAN_CAPABILITY_MATRIX } from "../subscription/services/plan-capabilities";
import { DEFAULT_DASHBOARD_SUPPORT_CONFIG } from "../support/dashboard-config";
import {
  clearSystemSettingsCache,
  getRuntimeSettingNumber,
  initializeMissingSystemSettingsDefaults,
} from "./index";

type StoredSetting = {
  key: string;
  value: unknown;
  isSecret?: boolean;
  updatedBy?: string | null;
  updatedAt?: Date | null;
};

const store = vi.hoisted(() => new Map<string, StoredSetting>());

const dbMock = vi.hoisted(() => {
  const readRows = () =>
    [...store.values()].map((row) => ({
      key: row.key,
      value: row.value,
    }));
  const selectBuilder = {
    from: vi.fn(() => selectBuilder),
    where: vi.fn(async () => readRows()),
    // biome-ignore lint/suspicious/noThenProperty: 故意实现 thenable，模拟 drizzle 查询构造器被 await 时的行为
    then: vi.fn((resolve, reject) =>
      Promise.resolve(readRows()).then(resolve, reject)
    ),
  };
  let pendingRows: StoredSetting[] = [];
  const insertBuilder = {
    values: vi.fn((values: StoredSetting | StoredSetting[]) => {
      pendingRows = Array.isArray(values) ? values : [values];
      for (const value of pendingRows) {
        if (!store.has(value.key)) {
          store.set(value.key, { ...value });
        }
      }
      return insertBuilder;
    }),
    onConflictDoNothing: vi.fn(async () => undefined),
    onConflictDoUpdate: vi.fn(async () => {
      for (const value of pendingRows) {
        store.set(value.key, { ...value });
      }
    }),
  };
  const deleteBuilder = {
    where: vi.fn(async (keys: unknown) => {
      if (!Array.isArray(keys)) return;
      for (const key of keys) {
        store.delete(String(key));
      }
    }),
  };

  return {
    select: vi.fn(() => selectBuilder),
    insert: vi.fn(() => insertBuilder),
    delete: vi.fn(() => deleteBuilder),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        insert: vi.fn(() => insertBuilder),
        delete: vi.fn(() => deleteBuilder),
      })
    ),
    selectBuilder,
    insertBuilder,
    deleteBuilder,
  };
});

vi.mock("@repo/database", () => ({
  db: dbMock,
}));

vi.mock("@repo/database/schema", () => ({
  systemSetting: {
    key: "key",
    value: "value",
    isSecret: "is_secret",
    updatedBy: "updated_by",
    updatedAt: "updated_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  inArray: vi.fn((_field: unknown, values: unknown[]) => values),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

describe("system setting default initialization", () => {
  beforeEach(() => {
    store.clear();
    clearSystemSettingsCache();
    dbMock.select.mockClear();
    dbMock.insert.mockClear();
    dbMock.delete.mockClear();
    dbMock.transaction.mockClear();
    dbMock.selectBuilder.from.mockClear();
    dbMock.selectBuilder.where.mockClear();
    dbMock.selectBuilder.then.mockClear();
    dbMock.insertBuilder.values.mockClear();
    dbMock.insertBuilder.onConflictDoNothing.mockClear();
    dbMock.insertBuilder.onConflictDoUpdate.mockClear();
    dbMock.deleteBuilder.where.mockClear();
  });

  it("persists missing non-secret defaults for a fresh database", async () => {
    const initializedKeys = await initializeMissingSystemSettingsDefaults({
      updatedBy: "admin-1",
    });

    expect(initializedKeys).toContain("PLAN_CAPABILITY_MATRIX");
    expect(initializedKeys).toContain(CREDIT_PACKAGE_MATRIX_SETTING_KEY);
    expect(initializedKeys).toContain("BILLING_YEARLY_ENABLED");
    expect(initializedKeys).not.toContain("APP_TIME_ZONE");
    expect(initializedKeys).toContain("MARKETING_SLA_STATUS_ENABLED");
    expect(initializedKeys).toContain("DASHBOARD_SUPPORT_CONFIG");
    expect(initializedKeys).toContain("SELF_USE_MODE_ENABLED");
    expect(initializedKeys).toContain("GENERATION_IMAGE_RETENTION_HOURS");
    expect(initializedKeys).toContain("GENERATION_IMAGE_RETENTION_MODE");
    expect(initializedKeys).toContain("GENERATION_IMAGE_MAX_COUNT");
    expect(initializedKeys).toContain("IMAGE_GENERATION_GLOBAL_CONCURRENCY");
    expect(initializedKeys).not.toContain("IMAGE_BASE_CREDITS_1024");
    expect(initializedKeys).not.toContain("IMAGE_BASE_CREDITS_1K");
    expect(initializedKeys).not.toContain("IMAGE_BASE_CREDITS_2K");
    expect(initializedKeys).not.toContain("IMAGE_BASE_CREDITS_4K");
    expect(initializedKeys).toContain("IMAGE_MODEL_CREDIT_PRICES");
    expect(initializedKeys).toContain("MODEL_MARKETPLACE_CONFIG");
    expect(initializedKeys).toContain("MODEL_MARKETPLACE_ASSETS_BUCKET_NAME");
    expect(initializedKeys).toContain("IMAGE_TEXT_MODERATION_CREDITS");
    expect(initializedKeys).toContain("IMAGE_INPUT_MODERATION_CREDITS");
    expect(initializedKeys).toContain("CONTENT_MODERATION_BLOCK_RISK_LEVEL");
    expect(initializedKeys).toContain("RATE_LIMIT_AI_REQUESTS_PER_MINUTE");
    expect(initializedKeys).not.toContain("BETTER_AUTH_SECRET");
    expect(initializedKeys).not.toContain("CREEM_API_KEY");

    expect(store.get("PLAN_CAPABILITY_MATRIX")?.value).toEqual(
      DEFAULT_PLAN_CAPABILITY_MATRIX
    );
    expect(store.get("PLAN_CAPABILITY_MATRIX")?.value).not.toHaveProperty(
      "moderation"
    );
    const storedPlanFeatures = (
      store.get("PLAN_CAPABILITY_MATRIX")?.value as {
        features: Record<string, unknown>;
      }
    ).features;
    expect(Object.hasOwn(storedPlanFeatures, "externalApi.relay")).toBe(false);
    expect(store.get("BILLING_YEARLY_ENABLED")?.value).toBe(true);
    expect(store.get("APP_TIME_ZONE")).toBeUndefined();
    expect(store.get("MARKETING_SLA_STATUS_ENABLED")?.value).toBe(true);
    expect(store.get("DASHBOARD_SUPPORT_CONFIG")?.value).toEqual(
      DEFAULT_DASHBOARD_SUPPORT_CONFIG
    );
    expect(store.get("SELF_USE_MODE_ENABLED")?.value).toBe(true);
    expect(store.get("GENERATION_IMAGE_RETENTION_HOURS")?.value).toBe(0);
    // 默认清理模式 off=永久保存（fail-safe）；最大张数默认 10000。
    expect(store.get("GENERATION_IMAGE_RETENTION_MODE")?.value).toBe("off");
    expect(store.get("GENERATION_IMAGE_MAX_COUNT")?.value).toBe(10000);
    expect(store.get("CREDITS_EXPIRY_DAYS")?.value).toBe(0);
    expect(store.get("IMAGE_GENERATION_GLOBAL_CONCURRENCY")?.value).toBe(500);
    expect(store.get("IMAGE_BASE_CREDITS_1024")).toBeUndefined();
    expect(store.get("IMAGE_BASE_CREDITS_1K")).toBeUndefined();
    expect(store.get("IMAGE_BASE_CREDITS_2K")).toBeUndefined();
    expect(store.get("IMAGE_BASE_CREDITS_4K")).toBeUndefined();
    expect(store.get("IMAGE_MODEL_CREDIT_PRICES")?.value).toEqual(
      createDefaultGlobalImageCreditOverrides()
    );
    expect(store.get("VIDEO_MODEL_CREDITS_PER_SECOND")?.value).toEqual(
      DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND
    );
    expect(store.get("MODEL_MARKETPLACE_CONFIG")?.value).toEqual(
      createDefaultModelMarketplaceConfig()
    );
    expect(store.get("MODEL_MARKETPLACE_ASSETS_BUCKET_NAME")?.value).toBe(
      "model-marketplace"
    );
    expect(store.get("IMAGE_TEXT_MODERATION_CREDITS")?.value).toBe(0.04);
    expect(store.get("IMAGE_INPUT_MODERATION_CREDITS")?.value).toBe(0.06);
    expect(store.get("CONTENT_MODERATION_BLOCK_RISK_LEVEL")?.value).toBe(
      "high"
    );
    expect(store.get("RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE")?.value).toBe(100);
    expect(store.get("RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE")?.value).toBe(5);
    expect(store.get("RATE_LIMIT_AI_REQUESTS_PER_MINUTE")?.value).toBe(20);
    expect(store.get("RATE_LIMIT_PAYMENT_REQUESTS_PER_MINUTE")?.value).toBe(10);
    expect(store.get("RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE")?.value).toBe(30);
    expect(store.get("RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE")?.value).toBe(3);
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(20);
    expect(store.get("BETTER_AUTH_SECRET")).toBeUndefined();
    expect(store.get("CREEM_API_KEY")).toBeUndefined();
  });

  it("does not overwrite an existing dedicated moderation policy", async () => {
    store.set("CONTENT_MODERATION_BLOCK_RISK_LEVEL", {
      key: "CONTENT_MODERATION_BLOCK_RISK_LEVEL",
      value: "medium",
    });

    const initializedKeys = await initializeMissingSystemSettingsDefaults();

    expect(initializedKeys).not.toContain(
      "CONTENT_MODERATION_BLOCK_RISK_LEVEL"
    );
    expect(store.get("CONTENT_MODERATION_BLOCK_RISK_LEVEL")?.value).toBe(
      "medium"
    );
  });

  it("不覆盖已经存在的模型广场展示配置", async () => {
    const existing = createDefaultModelMarketplaceConfig();
    existing.imageByModel["gpt-image-2"] = {
      revision: 7,
      visible: false,
      description: "保留现有配置",
      cover: null,
    };
    store.set("MODEL_MARKETPLACE_CONFIG", {
      key: "MODEL_MARKETPLACE_CONFIG",
      value: existing,
    });

    const initializedKeys = await initializeMissingSystemSettingsDefaults();

    expect(initializedKeys).not.toContain("MODEL_MARKETPLACE_CONFIG");
    expect(store.get("MODEL_MARKETPLACE_CONFIG")?.value).toEqual(existing);
  });

  it("migrates video model multipliers to fixed per-second prices", async () => {
    store.set("VIDEO_BASE_CREDITS_PER_SECOND", {
      key: "VIDEO_BASE_CREDITS_PER_SECOND",
      value: 30,
    });
    store.set("VIDEO_MODEL_MULTIPLIERS", {
      key: "VIDEO_MODEL_MULTIPLIERS",
      value: {
        "sora2-pro": 2,
        "veo31-fast": 0.5,
        invalid: 0,
      },
    });

    await initializeMissingSystemSettingsDefaults({ updatedBy: "admin-1" });

    expect(store.get("VIDEO_MODEL_CREDITS_PER_SECOND")?.value).toEqual({
      ...Object.fromEntries(
        Object.keys(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND).map((family) => [
          family,
          30,
        ])
      ),
      "sora2-pro": 60,
      "veo31-fast": 15,
    });
    expect(store.has("VIDEO_MODEL_MULTIPLIERS")).toBe(false);
  });

  it("does not overwrite explicit video model per-second prices", async () => {
    store.set("VIDEO_MODEL_MULTIPLIERS", {
      key: "VIDEO_MODEL_MULTIPLIERS",
      value: { sora2: 2 },
    });
    store.set("VIDEO_MODEL_CREDITS_PER_SECOND", {
      key: "VIDEO_MODEL_CREDITS_PER_SECOND",
      value: { sora2: 48 },
    });

    await initializeMissingSystemSettingsDefaults();

    expect(store.get("VIDEO_MODEL_CREDITS_PER_SECOND")?.value).toEqual({
      ...Object.fromEntries(
        Object.keys(DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND).map((family) => [
          family,
          30,
        ])
      ),
      sora2: 48,
    });
    expect(store.has("VIDEO_MODEL_MULTIPLIERS")).toBe(false);
  });

  it("补齐历史稀疏图像价格为全局必填矩阵", async () => {
    store.set("IMAGE_BASE_CREDITS_1024", {
      key: "IMAGE_BASE_CREDITS_1024",
      value: 2,
    });
    store.set("IMAGE_BASE_CREDITS_1K", {
      key: "IMAGE_BASE_CREDITS_1K",
      value: 3,
    });
    store.set("IMAGE_BASE_CREDITS_2K", {
      key: "IMAGE_BASE_CREDITS_2K",
      value: 6,
    });
    store.set("IMAGE_BASE_CREDITS_4K", {
      key: "IMAGE_BASE_CREDITS_4K",
      value: 11,
    });
    store.set("IMAGE_MODEL_CREDIT_PRICES", {
      key: "IMAGE_MODEL_CREDIT_PRICES",
      value: {
        version: 1,
        byModel: { "gpt-image-2": { base2kCredits: 8 } },
      },
    });

    await initializeMissingSystemSettingsDefaults({ updatedBy: "admin-1" });

    const expected = createDefaultGlobalImageCreditOverrides();
    for (const model of Object.keys(expected.byModel)) {
      expected.byModel[model] = {
        base1024Credits: 2,
        base1kCredits: 3,
        base2kCredits: 6,
        base4kCredits: 11,
      };
    }
    expected.byModel["gpt-image-2"] = {
      base1024Credits: 2,
      base1kCredits: 3,
      base2kCredits: 8,
      base4kCredits: 11,
    };
    expect(store.get("IMAGE_MODEL_CREDIT_PRICES")?.value).toEqual(expected);
  });

  it("删除旧 default 并将其价格一次性固化到历史稀疏真实模型", async () => {
    const legacyDefaultPricing = {
      base1024Credits: 2,
      base1kCredits: 3,
      base2kCredits: 6,
      base4kCredits: 11,
    };
    store.set("IMAGE_MODEL_CREDIT_PRICES", {
      key: "IMAGE_MODEL_CREDIT_PRICES",
      value: {
        version: 1,
        byModel: {
          default: legacyDefaultPricing,
          "vendor-custom-image": { base2kCredits: 8 },
        },
      },
    });

    await initializeMissingSystemSettingsDefaults({ updatedBy: "admin-1" });

    const storedPricing = store.get("IMAGE_MODEL_CREDIT_PRICES")?.value as {
      version: 1;
      byModel: Record<string, Record<string, number>>;
    };
    expect(storedPricing.byModel).not.toHaveProperty("default");
    expect(storedPricing.byModel["vendor-custom-image"]).toEqual({
      ...legacyDefaultPricing,
      base2kCredits: 8,
    });
    for (const model of Object.keys(createDefaultGlobalImageCreditOverrides().byModel)) {
      expect(storedPricing.byModel[model]).toEqual(legacyDefaultPricing);
    }
  });

  it("migrates legacy moderation public URL and removes legacy Aliyun controls", async () => {
    store.set("ALIYUN_MODERATION_PUBLIC_BASE_URL", {
      key: "ALIYUN_MODERATION_PUBLIC_BASE_URL",
      value: "https://images.example.com",
    });
    store.set("ALIYUN_MODERATION_BLOCK_RISK_LEVEL", {
      key: "ALIYUN_MODERATION_BLOCK_RISK_LEVEL",
      value: "medium",
    });

    await initializeMissingSystemSettingsDefaults();

    expect(store.get("CONTENT_MODERATION_PUBLIC_BASE_URL")?.value).toBe(
      "https://images.example.com"
    );
    expect(store.get("ALIYUN_MODERATION_PUBLIC_BASE_URL")).toBeUndefined();
    expect(store.get("ALIYUN_MODERATION_BLOCK_RISK_LEVEL")).toBeUndefined();
  });

  it("does not overwrite existing stored settings", async () => {
    store.set("PLAN_STARTER_MONTHLY_AMOUNT", {
      key: "PLAN_STARTER_MONTHLY_AMOUNT",
      value: 99,
    });
    store.set("PLAN_CAPABILITY_MATRIX", {
      key: "PLAN_CAPABILITY_MATRIX",
      value: {
        version: 1,
        features: {
          ...DEFAULT_PLAN_CAPABILITY_MATRIX.features,
          "imageGeneration.video": "starter",
        },
        limits: DEFAULT_PLAN_CAPABILITY_MATRIX.limits,
      },
    });

    const initializedKeys = await initializeMissingSystemSettingsDefaults();

    expect(initializedKeys).not.toContain("PLAN_STARTER_MONTHLY_AMOUNT");
    expect(initializedKeys).not.toContain("PLAN_CAPABILITY_MATRIX");
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(99);
    expect(
      (
        store.get("PLAN_CAPABILITY_MATRIX")
          ?.value as typeof DEFAULT_PLAN_CAPABILITY_MATRIX
      ).features["imageGeneration.video"]
    ).toBe("starter");
  });

  it("stores the credit package matrix without changing runtime fallback behavior", async () => {
    await initializeMissingSystemSettingsDefaults();
    clearSystemSettingsCache();

    const packages = await getRuntimeCreditPackages({ includeHidden: true });
    const payg = packages.find((pkg) => pkg.id === "payg_starter");
    const enterprise = packages.find((pkg) => pkg.id === "enterprise_resource");

    expect(payg).toMatchObject({
      credits: 5000,
      price: 20,
      visible: true,
      pricesByPlan: {
        free: 20,
        starter: 20,
        pro: 20,
        ultra: 20,
        enterprise: 20,
      },
    });
    expect(payg?.creemProductIdsByPlan).toBeUndefined();
    expect(enterprise).toMatchObject({
      credits: 5000,
      price: 15,
      visible: false,
      requiresPlan: "enterprise",
      pricesByPlan: {
        enterprise: 15,
      },
    });
    expect(enterprise?.creemProductId).toBeUndefined();
  });

  it("allows zero for non-negative runtime number settings", async () => {
    const previousEnvValue = process.env.CREDITS_EXPIRY_DAYS;
    delete process.env.CREDITS_EXPIRY_DAYS;
    store.set("CREDITS_EXPIRY_DAYS", {
      key: "CREDITS_EXPIRY_DAYS",
      value: 0,
    });

    try {
      await expect(
        getRuntimeSettingNumber("CREDITS_EXPIRY_DAYS", 365, {
          nonNegative: true,
        })
      ).resolves.toBe(0);

      await expect(
        getRuntimeSettingNumber("CREDITS_EXPIRY_DAYS", 365, {
          positive: true,
        })
      ).resolves.toBe(365);
    } finally {
      if (previousEnvValue === undefined) {
        delete process.env.CREDITS_EXPIRY_DAYS;
      } else {
        process.env.CREDITS_EXPIRY_DAYS = previousEnvValue;
      }
    }
  });
});
