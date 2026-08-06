/**
 * 账单用量页的生图计价卡数据装配器。
 *
 * 使用方只有 Billing 的 Usage 服务端分支。该文件聚合运行时定价、
 * 按量计费价格和平台默认后端分组，不将数据查询带入 Dashboard 首屏。
 */

import {
  type ImageCreditOverrides,
  type ResolvedImageCreditPricing,
  resolveImageCreditPricing,
} from "@repo/shared/image-backend/group-image-pricing";
import { isContentModerationEnabled } from "@repo/shared/moderation";

import { getEffectiveDefaultImageBackendGroup } from "@/features/image-backend-pool/catalog-service";
import {
  getRuntimeImageModelCreditPricing,
  getRuntimeImageModerationCreditPricing,
} from "@/features/image-generation/pricing-settings";
import type { ResolvedImageModerationCreditPricing } from "@/features/image-generation/resolution";

export type ImagePricingCardData = {
  billing: {
    groupName: string | null;
    moderationBlockingEnabled: boolean;
  };
  referenceModel: {
    id: string;
    pricing: ResolvedImageCreditPricing;
  };
  globalModelPricing: ImageCreditOverrides;
  groupModelOverrides: ImageCreditOverrides;
  moderationPricing: ResolvedImageModerationCreditPricing;
};

/**
 * 为当前用户装配生图计价卡所需的全部数据。
 *
 * @param userId 已鉴权会话的用户 ID。
 * @returns 标准化定价、审核附加费与平台默认后端分组。
 * @throws 运行时设置或数据库查询失败时向上抛出，由路由错误边界处理。
 */
export async function loadImagePricingCardData(
  _userId: string
): Promise<ImagePricingCardData> {
  const [globalModelPricing, moderationPricing, moderationSystemEnabled] =
    await Promise.all([
      getRuntimeImageModelCreditPricing(),
      getRuntimeImageModerationCreditPricing(),
      isContentModerationEnabled(),
    ]);
  const activeBackendGroup = await getEffectiveDefaultImageBackendGroup();
  const referenceModelId = Object.keys(globalModelPricing.byModel).sort()[0];
  if (!referenceModelId) {
    throw new Error("没有已配置价格的图像模型");
  }

  return {
    billing: {
      groupName: activeBackendGroup?.name ?? null,
      moderationBlockingEnabled:
        moderationSystemEnabled &&
        activeBackendGroup?.contentSafetyEnabled !== false,
    },
    referenceModel: {
      id: referenceModelId,
      pricing: resolveImageCreditPricing({
        model: referenceModelId,
        global: globalModelPricing,
      }),
    },
    globalModelPricing,
    groupModelOverrides: activeBackendGroup?.imageCreditOverrides ?? {
      version: 1,
      byModel: {},
    },
    moderationPricing,
  };
}
