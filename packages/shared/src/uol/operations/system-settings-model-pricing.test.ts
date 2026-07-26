/**
 * 全局模型价格只读 UOL 操作测试。
 *
 * 使用方：Vitest；锁定后端池等只读消费者仍能取得完整默认矩阵，同时不再注册旧的全量
 * 价格写入口。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND } from "../../adobe/video-pricing";
import { createDefaultGlobalImageCreditOverrides } from "../../image-backend/group-image-pricing";

const mocks = vi.hoisted(() => ({
  getRuntimeSettingJson: vi.fn<(key: string) => Promise<unknown>>(),
  setSystemSettings: vi.fn(),
}));

vi.mock("../../generation-maintenance", () => ({
  destroyGenerationPhotosByMaxCount: vi.fn(),
  shouldRunMaxCountCleanupOnSettingsChange: vi.fn(() => false),
}));
vi.mock("../../logger", () => ({ logError: vi.fn() }));
vi.mock("../../system-settings/bootstrap", () => ({
  bootstrapSystemSettingsEnv: vi.fn(),
}));
vi.mock("../../system-settings/env-file", () => ({
  syncSystemSettingsToEnvFiles: vi.fn(),
}));
vi.mock("../../system-settings/index", () => ({
  getAdminSystemSettingsSnapshot: vi.fn(),
  getRuntimeSettingJson: mocks.getRuntimeSettingJson,
  getSystemSettingValue: vi.fn(),
  importSystemSettingsFromEnv: vi.fn(),
  initializeMissingSystemSettingsDefaults: vi.fn(),
  setSystemSettings: mocks.setSystemSettings,
}));

import { settingsGetModelPricing } from "./system-settings";

describe("全局模型计费 UOL", () => {
  beforeEach(() => {
    mocks.getRuntimeSettingJson.mockReset();
    mocks.setSystemSettings.mockReset();
  });

  it("历史脏值读取时返回完整开发默认值", async () => {
    mocks.getRuntimeSettingJson.mockResolvedValue({});

    await expect(
      settingsGetModelPricing.execute(
        {},
        { type: "user", userId: "admin-1", role: "admin" },
        {
          requestId: "model-pricing-read",
          assertOwnership: vi.fn(),
        }
      )
    ).resolves.toEqual({
      image: createDefaultGlobalImageCreditOverrides(),
      videoCreditsPerSecond: DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
    });
  });
});
