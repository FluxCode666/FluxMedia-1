import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultModelMarketplaceConfig } from "../model-marketplace";
import { DEFAULT_DASHBOARD_SUPPORT_CONFIG } from "../support/dashboard-config";
import {
  clearSystemSettingsCache,
  getAdminSystemSettingsSnapshot,
  getRuntimeSettingBoolean,
  getRuntimeSettingJson,
  getRuntimeSettingSelect,
  getRuntimeSettingString,
  getSiteBranding,
  importSystemSettingsFromEnv,
  resetBootstrappedProcessSettingsForTests,
  setBootstrappedProcessSetting,
  setSiteLogoUrl,
  setSystemSettings,
} from "./index";

// DB-free 单测：用内存 store 模拟 systemSetting 表，覆盖 setSystemSettings
// 的写入主入口、coerceValue 校验门、importSystemSettingsFromEnv 的 overwrite
// 语义、getAdminSystemSettingsSnapshot 的密钥脱敏，以及运行时取值器的
// stored↔env 回退路径。所有逻辑不触达真实 @repo/database。

type StoredSetting = {
  key: string;
  value: unknown;
  isSecret?: boolean;
  updatedBy?: string | null;
  updatedAt?: Date | null;
};

const store = vi.hoisted(() => new Map<string, StoredSetting>());

// 记录最近一次 delete 命中的 key，用于校验 eq(key) 删除分支。
const deletedKeys = vi.hoisted(() => ({ value: [] as string[] }));

const dbMock = vi.hoisted(() => {
  const readRows = () =>
    [...store.values()].map((row) => ({
      key: row.key,
      value: row.value,
      isSecret: row.isSecret ?? false,
      updatedAt: row.updatedAt ?? null,
    }));

  const selectBuilder = {
    from: vi.fn(() => selectBuilder),
    where: vi.fn(async () => readRows()),
    // biome-ignore lint/suspicious/noThenProperty: Drizzle select builder intentionally implements PromiseLike for await.
    then: vi.fn((resolve, reject) =>
      Promise.resolve(readRows()).then(resolve, reject)
    ),
  };

  // upsert 语义：onConflictDoUpdate 时覆盖既有行，模拟 setSystemSettings/
  // importSystemSettingsFromEnv 的写入；onConflictDoNothing 时仅插入缺失行。
  const makeInsertBuilder = () => {
    let pending: StoredSetting[] = [];
    const insertBuilder = {
      values: vi.fn((values: StoredSetting | StoredSetting[]) => {
        pending = Array.isArray(values) ? values : [values];
        for (const value of pending) {
          if (!store.has(value.key)) {
            store.set(value.key, { ...value });
          }
        }
        return insertBuilder;
      }),
      onConflictDoNothing: vi.fn(async () => undefined),
      onConflictDoUpdate: vi.fn(async () => {
        for (const value of pending) {
          store.set(value.key, { ...value });
        }
      }),
    };
    return insertBuilder;
  };

  const deleteBuilder = {
    where: vi.fn(async (target: unknown) => {
      // setSystemSettings 用 eq(key) 删除：mock 的 eq 返回 { key }。
      if (
        target &&
        typeof target === "object" &&
        "key" in target &&
        typeof (target as { key: unknown }).key === "string"
      ) {
        const key = (target as { key: string }).key;
        deletedKeys.value.push(key);
        store.delete(key);
        return;
      }
      // 迁移逻辑用 inArray(...)：mock 的 inArray 返回 key 数组。
      if (Array.isArray(target)) {
        for (const key of target) {
          store.delete(String(key));
        }
      }
    }),
  };

  return {
    select: vi.fn(() => selectBuilder),
    insert: vi.fn(() => makeInsertBuilder()),
    delete: vi.fn(() => deleteBuilder),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        insert: vi.fn(() => makeInsertBuilder()),
        delete: vi.fn(() => deleteBuilder),
      })
    ),
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
  // eq 返回 { 列: 值 }，便于 deleteBuilder 识别 key 删除分支。
  eq: vi.fn((field: unknown, value: unknown) => ({ [String(field)]: value })),
  inArray: vi.fn((_field: unknown, values: unknown[]) => values),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

describe("setSystemSettings", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
    resetBootstrappedProcessSettingsForTests();
  });

  it("rejects unknown setting key throwing 未知配置项", async () => {
    await expect(
      setSystemSettings([{ key: "APP_TIME_ZONE", value: "UTC" }], "admin")
    ).rejects.toThrow("未知配置项: APP_TIME_ZONE");
  });

  it("clear entry deletes stored setting", async () => {
    store.set("NEXT_PUBLIC_APP_NAME", {
      key: "NEXT_PUBLIC_APP_NAME",
      value: "FluxMedia",
    });

    const changed = await setSystemSettings(
      [{ key: "NEXT_PUBLIC_APP_NAME", value: "", clear: true }],
      "admin"
    );

    expect(changed).toEqual(["NEXT_PUBLIC_APP_NAME"]);
    expect(store.has("NEXT_PUBLIC_APP_NAME")).toBe(false);
    expect(deletedKeys.value).toContain("NEXT_PUBLIC_APP_NAME");
  });

  it("skips blank secret to avoid wiping stored secret", async () => {
    store.set("BETTER_AUTH_SECRET", {
      key: "BETTER_AUTH_SECRET",
      value: "existing-secret",
      isSecret: true,
    });

    const changed = await setSystemSettings(
      [{ key: "BETTER_AUTH_SECRET", value: "   " }],
      "admin"
    );

    // 空白 secret 被跳过：既不写入也不计入 changedKeys，旧值保留。
    expect(changed).toEqual([]);
    expect(store.get("BETTER_AUTH_SECRET")?.value).toBe("existing-secret");
  });

  it("empty coerced string deletes the row", async () => {
    store.set("NEXT_PUBLIC_APP_NAME", {
      key: "NEXT_PUBLIC_APP_NAME",
      value: "Old Name",
    });

    const changed = await setSystemSettings(
      [{ key: "NEXT_PUBLIC_APP_NAME", value: "   " }],
      "admin"
    );

    expect(changed).toEqual(["NEXT_PUBLIC_APP_NAME"]);
    expect(store.has("NEXT_PUBLIC_APP_NAME")).toBe(false);
    expect(deletedKeys.value).toContain("NEXT_PUBLIC_APP_NAME");
  });

  it("upsert always stamps isSecret from definition not input", async () => {
    // BETTER_AUTH_SECRET 是 secret 定义项，写入时 isSecret 必须取自定义。
    await setSystemSettings(
      [{ key: "BETTER_AUTH_SECRET", value: "fresh-secret" }],
      "admin"
    );
    expect(store.get("BETTER_AUTH_SECRET")?.value).toBe("fresh-secret");
    expect(store.get("BETTER_AUTH_SECRET")?.isSecret).toBe(true);

    // NEXT_PUBLIC_APP_NAME 非 secret，isSecret 必为 false。
    await setSystemSettings(
      [{ key: "NEXT_PUBLIC_APP_NAME", value: "FluxMedia" }],
      "admin"
    );
    expect(store.get("NEXT_PUBLIC_APP_NAME")?.value).toBe("FluxMedia");
    expect(store.get("NEXT_PUBLIC_APP_NAME")?.isSecret).toBe(false);
  });

  it("拒绝把系统通用资产 bucket 保存为保留逻辑别名", async () => {
    await expect(
      setSystemSettings(
        [{ key: "SYSTEM_ASSETS_BUCKET_NAME", value: "_avatars" }],
        "admin"
      )
    ).rejects.toThrow("系统通用资产 Bucket 不能使用系统保留名称");
    expect(store.has("SYSTEM_ASSETS_BUCKET_NAME")).toBe(false);
  });

  it("coerces number values and rejects non-numeric (coerceValue, C-L25)", async () => {
    await setSystemSettings(
      [{ key: "REGISTRATION_BONUS_CREDITS", value: "2.5" }],
      "admin"
    );
    expect(store.get("REGISTRATION_BONUS_CREDITS")?.value).toBe(2.5);

    await expect(
      setSystemSettings(
        [{ key: "REGISTRATION_BONUS_CREDITS", value: "not-a-number" }],
        "admin"
      )
    ).rejects.toThrow(/必须是有效数字/);
  });

  it("enforces per-key number range bounds (coerceValue, S-M8)", async () => {
    // 经济键：价格 min=0.01 拒绝 0 与负数，max=1_000_000 拒绝异常巨大值。
    await expect(
      setSystemSettings(
        [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "0" }],
        "admin"
      )
    ).rejects.toThrow(/不能小于/);

    await expect(
      setSystemSettings(
        [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "-5" }],
        "admin"
      )
    ).rejects.toThrow(/不能小于/);

    await expect(
      setSystemSettings(
        [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "2000000" }],
        "admin"
      )
    ).rejects.toThrow(/不能大于/);

    // 边界：恰好等于下界/上界应通过（闭区间）。
    await setSystemSettings(
      [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "0.01" }],
      "admin"
    );
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(0.01);

    await setSystemSettings(
      [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "1000000" }],
      "admin"
    );
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(1_000_000);

    // 正常区间内的值原样写入。
    await setSystemSettings(
      [{ key: "PLAN_STARTER_MONTHLY_AMOUNT", value: "20" }],
      "admin"
    );
    expect(store.get("PLAN_STARTER_MONTHLY_AMOUNT")?.value).toBe(20);
  });

  it("allows registration bonus 0 but rejects negative (coerceValue, S-M8)", async () => {
    // 注册奖励积分 min=0：允许 0（关闭赠送），拒绝负数（会发负积分）。
    await setSystemSettings(
      [{ key: "REGISTRATION_BONUS_CREDITS", value: "0" }],
      "admin"
    );
    expect(store.get("REGISTRATION_BONUS_CREDITS")?.value).toBe(0);

    await expect(
      setSystemSettings(
        [{ key: "REGISTRATION_BONUS_CREDITS", value: "-1" }],
        "admin"
      )
    ).rejects.toThrow(/不能小于/);
  });

  it("rejects non-positive moderation timeout (coerceValue, S-M8)", async () => {
    // 审核超时 min=1：0 或负数会让审核请求立即超时，破坏 fail-closed/open 语义。
    await expect(
      setSystemSettings(
        [{ key: "CONTENT_MODERATION_PROVIDER_TIMEOUT_MS", value: "0" }],
        "admin"
      )
    ).rejects.toThrow(/不能小于/);

    await setSystemSettings(
      [{ key: "CONTENT_MODERATION_PROVIDER_TIMEOUT_MS", value: "1" }],
      "admin"
    );
    expect(store.get("CONTENT_MODERATION_PROVIDER_TIMEOUT_MS")?.value).toBe(1);
  });

  it("blank number input clears the row instead of coercing to 0 (S-M8)", async () => {
    store.set("PLAN_PRO_MONTHLY_AMOUNT", {
      key: "PLAN_PRO_MONTHLY_AMOUNT",
      value: 60,
    });

    // 空白数值视为清空：删除行回退默认值，且不被 min 范围误判。
    const changed = await setSystemSettings(
      [{ key: "PLAN_PRO_MONTHLY_AMOUNT", value: "   " }],
      "admin"
    );
    expect(changed).toEqual(["PLAN_PRO_MONTHLY_AMOUNT"]);
    expect(store.has("PLAN_PRO_MONTHLY_AMOUNT")).toBe(false);
    expect(deletedKeys.value).toContain("PLAN_PRO_MONTHLY_AMOUNT");
  });

  it("number key without declared range keeps coercion unchanged (S-M8)", async () => {
    // 未声明 min/max 的数值键（如全局并发）行为不变：任意有限数原样写入。
    await setSystemSettings(
      [{ key: "IMAGE_GENERATION_GLOBAL_CONCURRENCY", value: "999999" }],
      "admin"
    );
    expect(store.get("IMAGE_GENERATION_GLOBAL_CONCURRENCY")?.value).toBe(
      999999
    );
  });

  it("rejects malformed json and value not in select options (coerceValue, C-L25)", async () => {
    await expect(
      setSystemSettings(
        [{ key: "PLAN_CAPABILITY_MATRIX", value: "{not json" }],
        "admin"
      )
    ).rejects.toThrow(/必须是有效 JSON/);

    await expect(
      setSystemSettings(
        [{ key: "PAYMENT_PROVIDER", value: "definitely-not-an-option" }],
        "admin"
      )
    ).rejects.toThrow(/取值无效/);
  });

  it("validates and normalizes configured pagination sizes", async () => {
    await setSystemSettings(
      [{ key: "PAGINATION_PAGE_SIZE_OPTIONS", value: [50, 20, 10] }],
      "admin"
    );
    expect(store.get("PAGINATION_PAGE_SIZE_OPTIONS")?.value).toEqual([
      10, 20, 50,
    ]);

    for (const invalidValue of [[10, 50], [10, 20, 20], [10, 20, 101], {}]) {
      await expect(
        setSystemSettings(
          [{ key: "PAGINATION_PAGE_SIZE_OPTIONS", value: invalidValue }],
          "admin"
        )
      ).rejects.toThrow(/包含 20 的不重复整数数组/);
    }
  });

  it("validates dashboard support structure and safe links before writing", async () => {
    const configured = structuredClone(DEFAULT_DASHBOARD_SUPPORT_CONFIG);
    configured.officialSupport.qrCodeUrl =
      "https://assets.example.com/support.png";

    await setSystemSettings(
      [{ key: "DASHBOARD_SUPPORT_CONFIG", value: configured }],
      "admin"
    );
    expect(store.get("DASHBOARD_SUPPORT_CONFIG")?.value).toEqual(configured);

    const unsafe = structuredClone(DEFAULT_DASHBOARD_SUPPORT_CONFIG);
    unsafe.officialSupport.actionUrl = "javascript:alert(1)";
    await expect(
      setSystemSettings(
        [{ key: "DASHBOARD_SUPPORT_CONFIG", value: unsafe }],
        "admin"
      )
    ).rejects.toThrow(/字段或链接格式无效/);
  });

  it("拒绝通过通用入口写入或清空网站 Logo", async () => {
    for (const entry of [
      { key: "SITE_LOGO_URL", value: "/assets/brand/logo.svg" },
      { key: "SITE_LOGO_URL", value: "", clear: true },
    ]) {
      await expect(setSystemSettings([entry], "admin")).rejects.toThrow(
        /专用配置入口/
      );
    }
  });

  it("rejects generic writes and clears for the dedicated moderation policy", async () => {
    store.set("CONTENT_MODERATION_BLOCK_RISK_LEVEL", {
      key: "CONTENT_MODERATION_BLOCK_RISK_LEVEL",
      value: "high",
    });

    await expect(
      setSystemSettings(
        [{ key: "CONTENT_MODERATION_BLOCK_RISK_LEVEL", value: "low" }],
        "admin"
      )
    ).rejects.toThrow(/专用配置入口/);
    await expect(
      setSystemSettings(
        [
          {
            key: "CONTENT_MODERATION_BLOCK_RISK_LEVEL",
            value: "",
            clear: true,
          },
        ],
        "admin"
      )
    ).rejects.toThrow(/专用配置入口/);
    expect(store.get("CONTENT_MODERATION_BLOCK_RISK_LEVEL")?.value).toBe(
      "high"
    );
  });

  it("拒绝通过通用入口写入或清空模型广场配置", async () => {
    const existing = createDefaultModelMarketplaceConfig();
    store.set("MODEL_MARKETPLACE_CONFIG", {
      key: "MODEL_MARKETPLACE_CONFIG",
      value: existing,
    });

    await expect(
      setSystemSettings(
        [{ key: "MODEL_MARKETPLACE_CONFIG", value: { ...existing } }],
        "admin"
      )
    ).rejects.toThrow(/专用配置入口/);
    await expect(
      setSystemSettings(
        [{ key: "MODEL_MARKETPLACE_CONFIG", value: "", clear: true }],
        "admin"
      )
    ).rejects.toThrow(/专用配置入口/);
    expect(store.get("MODEL_MARKETPLACE_CONFIG")?.value).toEqual(existing);
  });
});

describe("setSiteLogoUrl", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
  });

  it("专用入口保存安全地址并返回公开 DTO", async () => {
    await expect(
      setSiteLogoUrl(" /assets/brand/logo.svg ", "super-admin-1")
    ).resolves.toEqual({ logoUrl: "/assets/brand/logo.svg" });
    expect(store.get("SITE_LOGO_URL")).toMatchObject({
      value: "/assets/brand/logo.svg",
      isSecret: false,
      updatedBy: "super-admin-1",
    });
  });

  it("恢复默认时删除覆盖值，且非法地址不会落库", async () => {
    store.set("SITE_LOGO_URL", {
      key: "SITE_LOGO_URL",
      value: "/assets/old-logo.svg",
    });

    await expect(setSiteLogoUrl(null, "super-admin-1")).resolves.toEqual({
      logoUrl: "/assets/icon.svg",
    });
    expect(store.has("SITE_LOGO_URL")).toBe(false);

    await expect(
      setSiteLogoUrl("javascript:alert(1)", "super-admin-1")
    ).rejects.toThrow();
    expect(store.has("SITE_LOGO_URL")).toBe(false);
  });
});

describe("importSystemSettingsFromEnv", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
    resetBootstrappedProcessSettingsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetBootstrappedProcessSettingsForTests();
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.SITE_LOGO_URL;
  });

  it("overwrite=false (importMissing) keeps existing stored value", async () => {
    store.set("NEXT_PUBLIC_APP_NAME", {
      key: "NEXT_PUBLIC_APP_NAME",
      value: "Stored Name",
    });
    process.env.NEXT_PUBLIC_APP_NAME = "Env Name";

    await importSystemSettingsFromEnv({ overwrite: false });

    expect(store.get("NEXT_PUBLIC_APP_NAME")?.value).toBe("Stored Name");
  });

  it("overwrite=true replaces stored value with env-derived value", async () => {
    store.set("NEXT_PUBLIC_APP_NAME", {
      key: "NEXT_PUBLIC_APP_NAME",
      value: "Stored Name",
    });
    process.env.NEXT_PUBLIC_APP_NAME = "Env Name";

    await importSystemSettingsFromEnv({ overwrite: true });

    expect(store.get("NEXT_PUBLIC_APP_NAME")?.value).toBe("Env Name");
  });

  it("flags isSecret true for secret-defined keys", async () => {
    process.env.BETTER_AUTH_SECRET = "env-secret";

    await importSystemSettingsFromEnv({ overwrite: true });

    expect(store.get("BETTER_AUTH_SECRET")?.value).toBe("env-secret");
    expect(store.get("BETTER_AUTH_SECRET")?.isSecret).toBe(true);
  });

  it("专用 Logo 配置不会从环境变量批量导入", async () => {
    process.env.SITE_LOGO_URL = "https://cdn.example.com/logo.png";

    await importSystemSettingsFromEnv({ overwrite: true });

    expect(store.has("SITE_LOGO_URL")).toBe(false);
  });

  it("never imports the dedicated moderation policy from env", async () => {
    store.set("CONTENT_MODERATION_BLOCK_RISK_LEVEL", {
      key: "CONTENT_MODERATION_BLOCK_RISK_LEVEL",
      value: "high",
    });
    vi.stubEnv("CONTENT_MODERATION_BLOCK_RISK_LEVEL", "low");

    await importSystemSettingsFromEnv({ overwrite: true });

    expect(store.get("CONTENT_MODERATION_BLOCK_RISK_LEVEL")?.value).toBe(
      "high"
    );
  });

  it("绝不从环境变量覆盖模型广场展示配置", async () => {
    const existing = createDefaultModelMarketplaceConfig();
    existing.imageByModel["gpt-image-2"] = {
      revision: 3,
      visible: true,
      description: "数据库真相",
      cover: null,
    };
    store.set("MODEL_MARKETPLACE_CONFIG", {
      key: "MODEL_MARKETPLACE_CONFIG",
      value: existing,
    });
    vi.stubEnv(
      "MODEL_MARKETPLACE_CONFIG",
      JSON.stringify({
        ...existing,
        imageByModel: {
          ...existing.imageByModel,
          "gpt-image-2": {
            ...existing.imageByModel["gpt-image-2"],
            revision: 9,
          },
        },
      })
    );

    await importSystemSettingsFromEnv({ overwrite: true });

    expect(store.get("MODEL_MARKETPLACE_CONFIG")?.value).toEqual(existing);
  });

  it("允许把系统通用资产 bucket 作为普通部署设置导入", async () => {
    store.set("SYSTEM_ASSETS_BUCKET_NAME", {
      key: "SYSTEM_ASSETS_BUCKET_NAME",
      value: "old-system-assets",
    });
    vi.stubEnv("SYSTEM_ASSETS_BUCKET_NAME", "production-system-assets");

    await importSystemSettingsFromEnv({ overwrite: true });

    expect(store.get("SYSTEM_ASSETS_BUCKET_NAME")?.value).toBe(
      "production-system-assets"
    );
  });
});

describe("getAdminSystemSettingsSnapshot", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
    resetBootstrappedProcessSettingsForTests();
  });

  afterEach(() => {
    resetBootstrappedProcessSettingsForTests();
    delete process.env.NEXT_PUBLIC_APP_NAME;
  });

  it("masks secret values to empty string even when stored", async () => {
    store.set("BETTER_AUTH_SECRET", {
      key: "BETTER_AUTH_SECRET",
      value: "super-secret-value",
      isSecret: true,
    });

    const snapshot = await getAdminSystemSettingsSnapshot();
    const secret = snapshot.find((item) => item.key === "BETTER_AUTH_SECRET");

    expect(secret?.value).toBe("");
    // 密钥已存储，但展示值脱敏；configured/stored 仍如实标记。
    expect(secret?.stored).toBe(true);
    expect(secret?.configured).toBe(true);
  });

  it("returns non-secret stored value verbatim", async () => {
    store.set("NEXT_PUBLIC_APP_NAME", {
      key: "NEXT_PUBLIC_APP_NAME",
      value: "Stored Name",
    });

    const snapshot = await getAdminSystemSettingsSnapshot();
    const appName = snapshot.find(
      (item) => item.key === "NEXT_PUBLIC_APP_NAME"
    );

    expect(appName?.value).toBe("Stored Name");
    expect(appName?.stored).toBe(true);
    expect(appName?.fromEnv).toBe(false);
  });

  it("falls back to trimmed env value when not stored and sets fromEnv=true", async () => {
    process.env.NEXT_PUBLIC_APP_NAME = "  Env Name  ";

    const snapshot = await getAdminSystemSettingsSnapshot();
    const appName = snapshot.find(
      (item) => item.key === "NEXT_PUBLIC_APP_NAME"
    );

    expect(appName?.value).toBe("Env Name");
    expect(appName?.stored).toBe(false);
    expect(appName?.fromEnv).toBe(true);
  });

  it("JSON.stringifies an object stored value for display", async () => {
    store.set("PLAN_CAPABILITY_MATRIX", {
      key: "PLAN_CAPABILITY_MATRIX",
      value: { version: 1 },
    });

    const snapshot = await getAdminSystemSettingsSnapshot();
    const matrix = snapshot.find(
      (item) => item.key === "PLAN_CAPABILITY_MATRIX"
    );

    expect(matrix?.value).toBe(JSON.stringify({ version: 1 }, null, 2));
  });
});

describe("legacy storage setting aliases", () => {
  beforeEach(() => {
    store.clear();
    clearSystemSettingsCache();
    resetBootstrappedProcessSettingsForTests();
  });

  it("旧读取键统一返回两个新设置的数据库真相", async () => {
    store.set("SYSTEM_ASSETS_BUCKET_NAME", {
      key: "SYSTEM_ASSETS_BUCKET_NAME",
      value: "system-assets",
    });
    store.set("GENERATIONS_BUCKET_NAME", {
      key: "GENERATIONS_BUCKET_NAME",
      value: "user-outputs",
    });

    await expect(
      getRuntimeSettingString("NEXT_PUBLIC_AVATARS_BUCKET_NAME")
    ).resolves.toBe("system-assets");
    await expect(
      getRuntimeSettingString("MODEL_MARKETPLACE_ASSETS_BUCKET_NAME")
    ).resolves.toBe("system-assets");
    await expect(
      getRuntimeSettingString("SITE_ASSETS_BUCKET_NAME")
    ).resolves.toBe("system-assets");
    await expect(
      getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")
    ).resolves.toBe("user-outputs");
  });
});

describe("runtime setting getters stored/env fallback (C-L29)", () => {
  beforeEach(() => {
    store.clear();
    deletedKeys.value = [];
    clearSystemSettingsCache();
    resetBootstrappedProcessSettingsForTests();
  });

  afterEach(() => {
    resetBootstrappedProcessSettingsForTests();
    delete process.env.SELF_USE_MODE_ENABLED;
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.PLAN_CAPABILITY_MATRIX;
  });

  it("getRuntimeSettingBoolean reads stored boolean, then env truthy string, else fallback", async () => {
    store.set("SELF_USE_MODE_ENABLED", {
      key: "SELF_USE_MODE_ENABLED",
      value: true,
    });
    await expect(
      getRuntimeSettingBoolean("SELF_USE_MODE_ENABLED")
    ).resolves.toBe(true);

    store.clear();
    clearSystemSettingsCache();
    process.env.SELF_USE_MODE_ENABLED = "yes";
    await expect(
      getRuntimeSettingBoolean("SELF_USE_MODE_ENABLED")
    ).resolves.toBe(true);

    delete process.env.SELF_USE_MODE_ENABLED;
    clearSystemSettingsCache();
    await expect(
      getRuntimeSettingBoolean("SELF_USE_MODE_ENABLED", true)
    ).resolves.toBe(true);
  });

  it("getRuntimeSettingString prefers stored over env and trims", async () => {
    store.set("NEXT_PUBLIC_APP_NAME", {
      key: "NEXT_PUBLIC_APP_NAME",
      value: "  Stored Name  ",
    });
    process.env.NEXT_PUBLIC_APP_NAME = "Env Name";

    await expect(getRuntimeSettingString("NEXT_PUBLIC_APP_NAME")).resolves.toBe(
      "Stored Name"
    );

    store.clear();
    clearSystemSettingsCache();
    await expect(getRuntimeSettingString("NEXT_PUBLIC_APP_NAME")).resolves.toBe(
      "Env Name"
    );
  });

  it("站点品牌读取对缺失和历史脏值使用内置 Logo 回退", async () => {
    await expect(getSiteBranding()).resolves.toEqual({
      logoUrl: "/assets/icon.svg",
    });

    store.set("SITE_LOGO_URL", {
      key: "SITE_LOGO_URL",
      value: "data:image/svg+xml,<svg />",
    });
    clearSystemSettingsCache();
    await expect(getSiteBranding()).resolves.toEqual({
      logoUrl: "/assets/icon.svg",
    });
  });

  it("getRuntimeSettingSelect returns fallback when value not in allowed list", async () => {
    store.set("PAYMENT_PROVIDER", {
      key: "PAYMENT_PROVIDER",
      value: "unknown-provider",
    });

    await expect(
      getRuntimeSettingSelect(
        "PAYMENT_PROVIDER",
        ["creem", "epay"] as const,
        "creem"
      )
    ).resolves.toBe("creem");

    store.set("PAYMENT_PROVIDER", {
      key: "PAYMENT_PROVIDER",
      value: "epay",
    });
    clearSystemSettingsCache();
    await expect(
      getRuntimeSettingSelect(
        "PAYMENT_PROVIDER",
        ["creem", "epay"] as const,
        "creem"
      )
    ).resolves.toBe("epay");
  });

  it("getRuntimeSettingJson parses stored string JSON and returns object directly", async () => {
    store.set("PLAN_CAPABILITY_MATRIX", {
      key: "PLAN_CAPABILITY_MATRIX",
      value: '{"version":2}',
    });
    await expect(
      getRuntimeSettingJson("PLAN_CAPABILITY_MATRIX")
    ).resolves.toEqual({ version: 2 });

    store.set("PLAN_CAPABILITY_MATRIX", {
      key: "PLAN_CAPABILITY_MATRIX",
      value: { version: 3 },
    });
    clearSystemSettingsCache();
    await expect(
      getRuntimeSettingJson("PLAN_CAPABILITY_MATRIX")
    ).resolves.toEqual({ version: 3 });
  });

  it("clear falls back to deployment env instead of bootstrapped DB env", async () => {
    process.env.NEXT_PUBLIC_APP_NAME = "Env Name";
    setBootstrappedProcessSetting("NEXT_PUBLIC_APP_NAME", "Stored Name");
    store.set("NEXT_PUBLIC_APP_NAME", {
      key: "NEXT_PUBLIC_APP_NAME",
      value: "Stored Name",
    });

    await setSystemSettings(
      [{ key: "NEXT_PUBLIC_APP_NAME", clear: true, value: "" }],
      "admin"
    );

    expect(process.env.NEXT_PUBLIC_APP_NAME).toBe("Stored Name");
    await expect(getRuntimeSettingString("NEXT_PUBLIC_APP_NAME")).resolves.toBe(
      "Env Name"
    );
  });
});

describe("legacy storage setting aliases", () => {
  beforeEach(() => {
    store.clear();
    clearSystemSettingsCache();
    resetBootstrappedProcessSettingsForTests();
  });

  it("旧读取键统一返回两个新设置的数据库真相", async () => {
    store.set("SYSTEM_ASSETS_BUCKET_NAME", {
      key: "SYSTEM_ASSETS_BUCKET_NAME",
      value: "system-assets",
    });
    store.set("GENERATIONS_BUCKET_NAME", {
      key: "GENERATIONS_BUCKET_NAME",
      value: "user-outputs",
    });

    await expect(
      getRuntimeSettingString("NEXT_PUBLIC_AVATARS_BUCKET_NAME")
    ).resolves.toBe("system-assets");
    await expect(
      getRuntimeSettingString("MODEL_MARKETPLACE_ASSETS_BUCKET_NAME")
    ).resolves.toBe("system-assets");
    await expect(
      getRuntimeSettingString("SITE_ASSETS_BUCKET_NAME")
    ).resolves.toBe("system-assets");
    await expect(
      getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")
    ).resolves.toBe("user-outputs");
  });
});
