import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSystemSettingsCache, getAdminSystemSettingsSnapshot, getRuntimeSettingBoolean, getRuntimeSettingSelect, getRuntimeSettingString, getSiteBranding, resetBootstrappedProcessSettingsForTests, setBootstrappedProcessSetting, setSystemSettings } from "./index";

// Validation, masked snapshots, atomic updates and legacy data migration are
// exercised against PostgreSQL in api-gateway/system_settings*_test.go. These
// tests cover the remaining shared adapter and environment fallback contracts.
const store = vi.hoisted(() => new Map<string, {key:string;value:unknown}>());
const go = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn() }));
vi.mock("../http/go-backend", () => ({requestGoBackendInternalJson:go.read, requestGoBackendJson:go.request}));
beforeEach(() => {
  go.read.mockReset().mockImplementation(async (path:string) => ({value:store.get(new URL(path,"http://go").searchParams.get("key")!)?.value ?? null}));
  go.request.mockReset().mockImplementation(async (_path:string,init:RequestInit) => {
    const {settings}=JSON.parse(String(init.body));
    for (const entry of settings) { if(entry.clear) store.delete(entry.key);else store.set(entry.key,entry); }
    return {changedKeys:settings.map((entry:{key:string})=>entry.key)};
  });
});

describe("runtime setting getters stored/env fallback (C-L29)", () => {
  beforeEach(() => {
    store.clear();
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

describe("Go settings failures",()=>{
  it("does not turn a failed backend read into empty configuration",async()=>{
    go.read.mockRejectedValueOnce(new Error("backend unavailable"));
    await expect(getRuntimeSettingString("NEXT_PUBLIC_APP_NAME")).rejects.toThrow("backend unavailable");
  });
  it("propagates atomic update failures and preserves the last confirmed data",async()=>{
    store.set("NEXT_PUBLIC_APP_NAME",{key:"NEXT_PUBLIC_APP_NAME",value:"before"});
    go.request.mockRejectedValueOnce(new Error("没有权限执行此操作"));
    await expect(setSystemSettings([{key:"NEXT_PUBLIC_APP_NAME",value:"after"}],"forged-admin")).rejects.toThrow("没有权限");
    await expect(getRuntimeSettingString("NEXT_PUBLIC_APP_NAME")).resolves.toBe("before");
  });
  it("preserves masked snapshot metadata from Go",async()=>{
    const settings=[{key:"SMTP_PASS",value:"",configured:true,stored:true,fromEnv:false,updatedAt:null}];
    go.request.mockResolvedValueOnce({settings});
    await expect(getAdminSystemSettingsSnapshot()).resolves.toEqual(settings);
  });
});
