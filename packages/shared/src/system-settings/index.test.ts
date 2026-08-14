import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultModelMarketplaceConfig } from "../model-marketplace";
import { DEFAULT_DASHBOARD_SUPPORT_CONFIG } from "../support/dashboard-config";
import {
  clearSystemSettingsCache,
  getAdminSystemSettingsSnapshot,
  getRuntimeSettingBoolean,
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
        execute: vi.fn(async () => []),
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

  it("拒绝未知配置键且不在提示中回显未受信任键名", async () => {
    const error = await setSystemSettings(
      [{ key: "APP_TIME_ZONE", value: "UTC" }],
      "admin"
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "SystemSettingValidationError",
      fieldLabel: "系统设置",
      reason: "包含未知或已下线的字段，请刷新页面后重试",
    });
    expect(String(error)).not.toContain("APP_TIME_ZONE");
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

  it("存在运营导出任务时拒绝切换对象存储配置", async () => {
    const execute = vi.fn(async (query: unknown) => {
      if (query && typeof query === "object" && "strings" in query) {
        const strings = (query as { strings: readonly string[] }).strings;
        if (strings.some((value) => value.includes("from operations_export_task"))) {
          return [{ exists: 1 }];
        }
      }
      return [];
    });
    vi.mocked(dbMock.transaction).mockImplementationOnce(
      async (callback: (tx: unknown) => Promise<void>) =>
        callback({
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              onConflictDoUpdate: vi.fn(),
              onConflictDoNothing: vi.fn(),
            })),
          })),
          delete: vi.fn(() => ({ where: vi.fn() })),
          execute,
        })
    );

    await expect(
      setSystemSettings(
        [{ key: "STORAGE_BUCKET_NAME", value: "new-exports" }],
        "admin"
      )
    ).rejects.toThrow("存在未完成或尚未清理的运营导出任务");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.has("STORAGE_BUCKET_NAME")).toBe(false);
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
    ).rejects.toThrow("系统通用资产 Bucket：不能使用系统保留名称");
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

  it("用可识别的设置校验错误保留字段与安全原因", async () => {
    await expect(
      setSystemSettings(
        [{ key: "MEDIA_MAX_UPLOAD_SIZE_MB", value: 513 }],
        "admin"
      )
    ).rejects.toMatchObject({
      name: "SystemSettingValidationError",
      fieldLabel: "单次上传总量 MB",
      reason: "不能大于 512",
      message: "单次上传总量 MB：不能大于 512",
    });
  });

  it("number key without declared range keeps coercion unchanged (S-M8)", async () => {
    // 未声明 min/max 的数值键行为不变：任意有限数原样写入。
    await setSystemSettings(
      [{ key: "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES", value: "999999" }],
      "admin"
    );
    expect(store.get("IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES")?.value).toBe(
      999999
    );
  });

  it("enforces media governance setting ranges", async () => {
    const cases = [
      ["IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY", 10_000],
      ["MEDIA_MAX_FILE_SIZE_MB", 200],
      ["MEDIA_MAX_UPLOAD_SIZE_MB", 512],
      ["IMAGE_EDIT_MAX_REFERENCE_IMAGES", 256],
    ] as const;

    for (const [key, max] of cases) {
      await setSystemSettings([{ key, value: max }], "admin");
      expect(store.get(key)?.value).toBe(max);
      await expect(
        setSystemSettings([{ key, value: 0 }], "admin")
      ).rejects.toThrow(/不能小于/);
      await expect(
        setSystemSettings([{ key, value: max + 1 }], "admin")
      ).rejects.toThrow(/不能大于/);
      await expect(
        setSystemSettings([{ key, value: 1.5 }], "admin")
      ).rejects.toThrow(/必须是整数/);
    }
  });

  it("enforces video submission retry and timeout setting ranges", async () => {
    const cases = [
      {
        key: "VIDEO_SUBMISSION_RETRY_DELAY_SECONDS",
        valid: [0, 2, 300],
        invalid: [-1, 1.5, 301],
      },
      {
        key: "VIDEO_SUBMISSION_HTTP_TIMEOUT_SECONDS",
        valid: [1, 30, 300],
        invalid: [0, -1, 1.5, 301],
      },
      {
        key: "VIDEO_SUBMISSION_CAPACITY_WAIT_TIMEOUT_SECONDS",
        valid: [0, 120, 1_800],
        invalid: [-1, 1.5, 1_801],
      },
    ] as const;

    for (const { key, valid, invalid } of cases) {
      for (const value of valid) {
        await setSystemSettings([{ key, value }], "admin");
        expect(store.get(key)?.value).toBe(value);
      }
      for (const value of invalid) {
        await expect(
          setSystemSettings([{ key, value }], "admin")
        ).rejects.toThrow(/不能小于|不能大于|必须是整数/);
      }
    }
  });

  it("rejects values not in select options (coerceValue, C-L25)", async () => {
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
