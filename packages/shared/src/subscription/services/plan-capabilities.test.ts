/**
 * 媒体平台套餐能力矩阵测试。
 *
 * 职责：锁定保留能力、旧字段清理、限制单调性和运行时设置回退，防止已退场的
 * Chat/Agent/Responses/PPT/PSD 通过历史 JSON 再次出现。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PLAN_RANK, SUBSCRIPTION_PLANS } from "../../config/subscription-plan";
import { SYSTEM_SETTING_DEFINITIONS } from "../../system-settings/definitions";
import {
  canUsePlanCapability,
  DEFAULT_PLAN_CAPABILITY_MATRIX,
  DEFAULT_PLAN_CAPABILITY_MATRIX_JSON,
  getPlanCapabilityMatrix,
  getPlanCapabilitySnapshot,
  MAX_PLAN_IMAGE_COUNT,
  normalizePlanCapabilityMatrix,
  PLAN_CAPABILITY_KEYS,
} from "./plan-capabilities";

const runtimeSettingsMock = vi.hoisted(() => ({
  getRuntimeSettingJson: vi.fn(),
  getRuntimeSettingNumber: vi.fn(),
}));

const removedCapabilityKeys = {
  imageChat: ["imageGeneration", "chat"].join("."),
  imageAgent: ["imageGeneration", "agent"].join("."),
  imageWaterfall: ["imageGeneration", "waterfall"].join("."),
  externalChat: ["externalApi", "chat", "completions"].join("."),
  externalResponses: ["externalApi", "responses"].join("."),
  externalAgent: ["externalApi", "agent"].join("."),
  pptExport: ["export", "ppt"].join("."),
  psdExport: ["export", "psd"].join("."),
} as const;

vi.mock("../../system-settings", () => runtimeSettingsMock);

describe("media plan capability matrix", () => {
  beforeEach(() => {
    runtimeSettingsMock.getRuntimeSettingJson.mockReset();
    runtimeSettingsMock.getRuntimeSettingNumber.mockReset();
  });

  it("contains only retained media and governance capabilities", () => {
    const matrix = normalizePlanCapabilityMatrix(undefined);
    expect(matrix).toEqual(DEFAULT_PLAN_CAPABILITY_MATRIX);
    expect(JSON.parse(DEFAULT_PLAN_CAPABILITY_MATRIX_JSON)).toEqual(matrix);
    expect(Object.keys(matrix.features).sort()).toEqual(
      [...PLAN_CAPABILITY_KEYS].sort()
    );
    for (const removed of Object.values(removedCapabilityKeys)) {
      expect(PLAN_CAPABILITY_KEYS).not.toContain(removed);
      expect(matrix.features).not.toHaveProperty(removed);
    }
    expect(matrix).not.toHaveProperty("billing");
    expect(matrix.limits.free).not.toHaveProperty("maxChatImages");
    expect(matrix.limits.free).not.toHaveProperty("maxChatContextChars");
  });

  it("keeps the system settings example synchronized", () => {
    const setting = SYSTEM_SETTING_DEFINITIONS.find(
      ({ key }) => key === "PLAN_CAPABILITY_MATRIX"
    );
    expect(
      setting && "exampleValue" in setting ? setting.exampleValue : undefined
    ).toEqual(DEFAULT_PLAN_CAPABILITY_MATRIX);
  });

  it("ignores removed and unknown stored fields", () => {
    const matrix = normalizePlanCapabilityMatrix({
      features: {
        "imageGeneration.video": "pro",
        [removedCapabilityKeys.externalResponses]: "free",
        [removedCapabilityKeys.psdExport]: "free",
        unknown: "enterprise",
      },
      limits: {
        free: {
          maxChatImages: 999,
          maxChatContextChars: 999_999,
        },
      },
      billing: {
        free: { chatRoundCredits: 0, agentRoundCredits: 0 },
      },
    });
    expect(matrix.features["imageGeneration.video"]).toBe("pro");
    expect(matrix.features).not.toHaveProperty(
      removedCapabilityKeys.externalResponses
    );
    expect(matrix.features).not.toHaveProperty(removedCapabilityKeys.psdExport);
    expect(matrix.limits.free).not.toHaveProperty("maxChatImages");
    expect(matrix).not.toHaveProperty("billing");
  });

  it("clamps request limits and keeps higher plans monotonic", () => {
    const matrix = normalizePlanCapabilityMatrix({
      limits: {
        free: {
          maxFileMb: 500,
          maxUploadMb: 600,
          queuePriority: "highest",
          imageGenerationConcurrency: 20_000,
          monthlyCredits: 900_000,
          maxEditImages: MAX_PLAN_IMAGE_COUNT + 1,
        },
      },
    });
    expect(matrix.limits.free).toMatchObject({
      imageGenerationConcurrency: 10_000,
      maxEditImages: MAX_PLAN_IMAGE_COUNT,
    });
    for (const plan of SUBSCRIPTION_PLANS) {
      expect(matrix.limits[plan].maxFileMb).toBeGreaterThanOrEqual(500);
      expect(matrix.limits[plan].maxUploadMb).toBeGreaterThanOrEqual(600);
      expect(matrix.limits[plan].queuePriority).toBe("highest");
    }
  });

  it("uses configured runtime matrix for capability snapshots", async () => {
    runtimeSettingsMock.getRuntimeSettingJson.mockResolvedValue({
      features: {
        ...DEFAULT_PLAN_CAPABILITY_MATRIX.features,
        "externalApi.videos.generate": "pro",
      },
      limits: DEFAULT_PLAN_CAPABILITY_MATRIX.limits,
    });

    await expect(
      canUsePlanCapability("starter", "externalApi.videos.generate")
    ).resolves.toBe(false);
    await expect(
      canUsePlanCapability("pro", "externalApi.videos.generate")
    ).resolves.toBe(true);
    const snapshot = await getPlanCapabilitySnapshot("pro");
    expect(snapshot.features["externalApi.videos.generate"]).toBe(true);
    expect(snapshot).not.toHaveProperty("billing");
  });

  it("uses legacy upload and monthly credit settings when matrix is absent", async () => {
    runtimeSettingsMock.getRuntimeSettingJson.mockResolvedValue(undefined);
    runtimeSettingsMock.getRuntimeSettingNumber.mockImplementation(
      async (key: string, fallback: number) => {
        if (key === "PLAN_PRO_MAX_FILE_MB") return 88;
        if (key === "PLAN_PRO_MONTHLY_CREDITS") return 123_456;
        return fallback;
      }
    );

    const matrix = await getPlanCapabilityMatrix();
    expect(matrix.limits.pro.maxFileMb).toBe(88);
    expect(matrix.limits.pro.monthlyCredits).toBe(123_456);
    for (const plan of SUBSCRIPTION_PLANS) {
      const next = SUBSCRIPTION_PLANS.find(
        (candidate) => PLAN_RANK[candidate] === PLAN_RANK[plan] + 1
      );
      if (!next) continue;
      expect(matrix.limits[next].maxFileMb).toBeGreaterThanOrEqual(
        matrix.limits[plan].maxFileMb
      );
    }
  });
});
