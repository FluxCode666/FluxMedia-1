import {beforeEach,describe,expect,it,vi} from "vitest";
import {DEFAULT_VIDEO_MODEL_BILLING_MODES,DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND} from "../video-generation/video-pricing";
import {SETTING_DEFINITION_BY_KEY} from "./definitions";
import {clearSystemSettingsCache,getRuntimeSettingNumber,getAuthoritativeVideoModelBillingSettings,getRuntimeVideoModelBillingSettings,initializeMissingSystemSettingsDefaults} from "./index";
const store=vi.hoisted(()=>new Map<string,{key:string;value:unknown}>());
const go=vi.hoisted(()=>vi.fn());
vi.mock("../http/go-backend",()=>({requestGoBackendInternalJson:go,requestGoBackendJson:go}));
// Persistent initialization parity is covered by Go PostgreSQL tests. The web
// retains only the display definitions and interpretation of returned values.
describe("settings definitions and Go defaults",()=>{
  beforeEach(()=>{store.clear();clearSystemSettingsCache();go.mockReset().mockImplementation(async(path:string)=>({value:store.get(new URL(path,"http://go").searchParams.get("key")!)?.value??null}));});
  it("returns the actual initialized keys and propagates initialization failure",async()=>{
    go.mockResolvedValueOnce({initializedKeys:["NEXT_PUBLIC_APP_NAME"]});
    await expect(initializeMissingSystemSettingsDefaults()).resolves.toEqual(["NEXT_PUBLIC_APP_NAME"]);
    go.mockRejectedValueOnce(new Error("initialization failed"));
    await expect(initializeMissingSystemSettingsDefaults()).rejects.toThrow("initialization failed");
  });
  it("运营导出任务定义默认关闭且限制批次与间隔", () => {
    expect(
      SETTING_DEFINITION_BY_KEY.get(
        "INTERNAL_JOB_OPERATIONS_EXPORT_PROCESS_ENABLED"
      )
    ).toMatchObject({ valueType: "boolean", defaultValue: false });
    expect(
      SETTING_DEFINITION_BY_KEY.get(
        "INTERNAL_JOB_OPERATIONS_EXPORT_EXPIRE_ENABLED"
      )
    ).toMatchObject({ valueType: "boolean", defaultValue: false });
    for (const key of [
      "INTERNAL_JOB_OPERATIONS_EXPORT_PROCESS_BATCH_SIZE",
      "INTERNAL_JOB_OPERATIONS_EXPORT_EXPIRE_BATCH_SIZE",
    ] as const) {
      expect(SETTING_DEFINITION_BY_KEY.get(key)).toMatchObject({
        valueType: "number",
        min: 1,
        max: 100,
        integer: true,
      });
    }
  });

  it("视频模式和按条价格只能由专用模型配置 operation 管理", () => {
    for (const key of [
      "VIDEO_MODEL_BILLING_MODES",
      "VIDEO_MODEL_CREDITS_PER_ITEM",
      "VIDEO_MODEL_CREDITS_PER_SECOND",
    ] as const) {
      expect(SETTING_DEFINITION_BY_KEY.get(key)).toMatchObject({
        category: "credits",
        valueType: "json",
        managedByDedicatedOperation: true,
      });
    }
  });

  it("权威读取绕过缓存并聚合已提交的三套视频计费设置", async () => {
    store.set("VIDEO_MODEL_BILLING_MODES", {
      key: "VIDEO_MODEL_BILLING_MODES",
      value: { ...DEFAULT_VIDEO_MODEL_BILLING_MODES, seedance2: "per_item" },
    });
    store.set("VIDEO_MODEL_CREDITS_PER_ITEM", {
      key: "VIDEO_MODEL_CREDITS_PER_ITEM",
      value: {
        ...DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
        "seedance2@1080p": 5,
      },
    });
    store.set("VIDEO_MODEL_CREDITS_PER_SECOND", {
      key: "VIDEO_MODEL_CREDITS_PER_SECOND",
      value: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
    });

    await expect(getAuthoritativeVideoModelBillingSettings()).resolves.toEqual({
      billingModes: {
        ...DEFAULT_VIDEO_MODEL_BILLING_MODES,
        seedance2: "per_item",
      },
      creditsPerItem: {
        ...DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
        "seedance2@1080p": 5,
      },
      creditsPerSecond: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
    });
  });

  it("缓存读取与权威读取使用同一聚合结果", async () => {
    store.set("VIDEO_MODEL_BILLING_MODES", {
      key: "VIDEO_MODEL_BILLING_MODES",
      value: { ...DEFAULT_VIDEO_MODEL_BILLING_MODES, seedance2: "per_item" },
    });
    store.set("VIDEO_MODEL_CREDITS_PER_ITEM", {
      key: "VIDEO_MODEL_CREDITS_PER_ITEM",
      value: {
        ...DEFAULT_VIDEO_MODEL_CREDITS_PER_ITEM,
        "seedance2@1080p": 5,
      },
    });
    store.set("VIDEO_MODEL_CREDITS_PER_SECOND", {
      key: "VIDEO_MODEL_CREDITS_PER_SECOND",
      value: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
    });

    await expect(getRuntimeVideoModelBillingSettings()).resolves.toEqual(
      await getAuthoritativeVideoModelBillingSettings()
    );
  });

  it("非法新计费模式由权威读取拒绝而不是静默回退按秒", async () => {
    store.set("VIDEO_MODEL_BILLING_MODES", {
      key: "VIDEO_MODEL_BILLING_MODES",
      value: { seedance2: "hourly" },
    });

    await expect(getAuthoritativeVideoModelBillingSettings()).rejects.toThrow();
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
