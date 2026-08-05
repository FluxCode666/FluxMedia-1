/**
 * 媒体上传限制的兼容读取服务。
 *
 * 使用方：站内生图、外部图片接口与上传校验。统一暴露单文件、请求总量和编辑图片
 * 数量上限。旧调用签名暂时保留 plan 参数以支持分阶段发布，但参数不再影响结果。
 */
import type { SubscriptionPlan } from "../../config/subscription-plan";
import { getMediaLimitDefaults } from "../../image-generation/media-limit-service";

export type PlanUploadLimits = {
  maxFileSizeBytes: number;
  maxUploadBytes: number;
  maxEditImages: number;
};

/** 读取并归一化指定套餐的媒体上传限制。 */
export async function getPlanUploadLimits(
  _plan: SubscriptionPlan
): Promise<PlanUploadLimits> {
  const limits = await getMediaLimitDefaults();

  return {
    maxFileSizeBytes: limits.maxFileSizeBytes,
    maxUploadBytes: limits.maxUploadSizeBytes,
    maxEditImages: limits.maxEditReferenceImages,
  };
}

/** 一次读取所有套餐的归一化媒体上传限制。 */
export async function getAllPlanUploadLimits(): Promise<
  Record<SubscriptionPlan, PlanUploadLimits>
> {
  const plans: SubscriptionPlan[] = [
    "free",
    "starter",
    "pro",
    "ultra",
    "enterprise",
  ];
  const entries = await Promise.all(
    plans.map(async (plan) => [plan, await getPlanUploadLimits(plan)] as const)
  );

  return Object.fromEntries(entries) as Record<
    SubscriptionPlan,
    PlanUploadLimits
  >;
}
