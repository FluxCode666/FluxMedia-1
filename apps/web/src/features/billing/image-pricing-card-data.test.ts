/**
 * 生图计价卡服务端数据装配测试。
 *
 * 使用 Vitest 隔离运行时设置与后端分组查询，确保账单展示使用与实际扣费一致的
 * 模型覆盖和审核价格契约。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveDefaultImageBackendGroup: vi.fn(
    async (): Promise<{
      id: string;
      imageCreditOverrides: {
        version: 1;
        byModel: Record<string, { base2kCredits: number }>;
      };
      contentSafetyEnabled: boolean | null;
      isDefault: boolean;
      name: string;
    } | null> => ({
      id: "group-selected",
      contentSafetyEnabled: true,
      imageCreditOverrides: {
        version: 1,
        byModel: {
          "gpt-image-2": { base2kCredits: 6.6 },
        },
      },
      isDefault: false,
      name: "专业池",
    })
  ),
  isContentModerationEnabled: vi.fn(async () => true),
  getRuntimeImageModelCreditPricing: vi.fn(async () => ({
    version: 1 as const,
    byModel: {
      "gpt-image-2": {
        base1024Credits: 1.5,
        base1kCredits: 2.5,
        base2kCredits: 5.5,
        base4kCredits: 10.5,
      },
    },
  })),
  getRuntimeImageModerationCreditPricing: vi.fn(async () => ({
    textModerationCredits: 0.13,
    imageModerationCredits: 0.27,
  })),
}));

vi.mock("@repo/shared/moderation", () => ({
  isContentModerationEnabled: mocks.isContentModerationEnabled,
}));

vi.mock("@/features/image-backend-pool/catalog-service", () => ({
  getEffectiveDefaultImageBackendGroup:
    mocks.getEffectiveDefaultImageBackendGroup,
}));

vi.mock("@/features/image-generation/pricing-settings", () => ({
  getRuntimeImageModelCreditPricing: mocks.getRuntimeImageModelCreditPricing,
  getRuntimeImageModerationCreditPricing:
    mocks.getRuntimeImageModerationCreditPricing,
}));

import { loadImagePricingCardData } from "./image-pricing-card-data";

describe("loadImagePricingCardData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveDefaultImageBackendGroup.mockResolvedValue({
      id: "group-selected",
      contentSafetyEnabled: true,
      imageCreditOverrides: {
        version: 1,
        byModel: {
          "gpt-image-2": { base2kCredits: 6.6 },
        },
      },
      isDefault: false,
      name: "专业池",
    });
  });

  it("返回运行时四档、全局模型价、默认分组覆盖和审核费", async () => {
    const result = await loadImagePricingCardData("user-1");

    expect(result).toMatchObject({
      billing: {
        groupName: "专业池",
        moderationBlockingEnabled: true,
      },
      referenceModel: {
        id: "gpt-image-2",
        pricing: {
          base1024Credits: 1.5,
          base1kCredits: 2.5,
          base2kCredits: 5.5,
          base4kCredits: 10.5,
        },
      },
      globalModelPricing: {
        version: 1,
        byModel: {
          "gpt-image-2": { base4kCredits: 10.5 },
        },
      },
      groupModelOverrides: {
        version: 1,
        byModel: {
          "gpt-image-2": { base2kCredits: 6.6 },
        },
      },
      moderationPricing: {
        imageModerationCredits: 0.27,
        textModerationCredits: 0.13,
      },
    });
    expect("groupMultiplier" in result.billing).toBe(false);
    expect(mocks.getEffectiveDefaultImageBackendGroup).toHaveBeenCalledWith();
  });

  it("无可用分组时返回空覆盖契约", async () => {
    mocks.getEffectiveDefaultImageBackendGroup.mockResolvedValue(null);

    const result = await loadImagePricingCardData("user-1");

    expect(result.billing.groupName).toBeNull();
    expect(result.groupModelOverrides).toEqual({ version: 1, byModel: {} });
  });

  it("审核总开关关闭时展示零审核附加", async () => {
    mocks.isContentModerationEnabled.mockResolvedValueOnce(false);

    const result = await loadImagePricingCardData("user-1");

    expect(result.billing.moderationBlockingEnabled).toBe(false);
    expect(result.moderationPricing).toEqual({
      imageModerationCredits: 0.27,
      textModerationCredits: 0.13,
    });
  });
});
