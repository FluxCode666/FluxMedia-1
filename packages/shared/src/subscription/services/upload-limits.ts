/**
 * 套餐媒体上传限制的字节化读取服务。
 *
 * 使用方：站内生图、外部图片接口与上传校验。统一暴露单文件、请求总量和编辑图片
 * 数量上限，避免客户端与 API 分别解释套餐能力矩阵。
 */
import type { SubscriptionPlan } from "../../config/subscription-plan";
import { getPlanLimits, megabytesToBytes } from "./plan-capabilities";

export type PlanUploadLimits = {
  maxFileSizeBytes: number;
  maxUploadBytes: number;
  maxEditImages: number;
};

/** 读取并归一化指定套餐的媒体上传限制。 */
export async function getPlanUploadLimits(
  plan: SubscriptionPlan
): Promise<PlanUploadLimits> {
  const limits = await getPlanLimits(plan);

  return {
    maxFileSizeBytes: megabytesToBytes(limits.maxFileMb),
    maxUploadBytes: megabytesToBytes(limits.maxUploadMb),
    maxEditImages: limits.maxEditImages,
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
