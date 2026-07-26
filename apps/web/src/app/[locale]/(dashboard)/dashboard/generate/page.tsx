/**
 * 简易生图菜单页路由。
 *
 * 使用方：控制台侧边栏的“简易生图”入口。
 * 关键依赖：服务端装配用户额度、套餐授权模型目录、上传限制、计价和近期图片，
 * 客户端只渲染旧版统一视觉的生图工作区。
 */
import { getCurrentUser } from "@repo/shared/auth/server";
import { getCreditsBalance } from "@repo/shared/credits/core";
import { isContentModerationEnabled } from "@repo/shared/moderation";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { getPlanUploadLimits } from "@repo/shared/subscription/services/upload-limits";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import {
  getEffectiveDefaultImageBackendGroup,
  getImageGenerationModelCatalogForPlan,
} from "@/features/image-backend-pool/catalog-service";
import { GeneratePageClient } from "@/features/image-generation/components/generate-page-client";
import {
  getRuntimeImageModelCreditPricing,
  getRuntimeImageModerationCreditPricing,
} from "@/features/image-generation/pricing-settings";
import { getUserRecentGenerations } from "@/features/image-generation/queries";

/**
 * 渲染独立的简易生图页面。
 *
 * @returns 已完成鉴权和套餐收窄的简易生图页面。
 * @sideEffects 读取账户、系统配置和近期生成记录；未登录时跳转登录页。
 * @failure 底层必需数据读取失败时交由 Next.js 错误边界处理，不伪造空授权目录。
 */
export default async function GeneratePage() {
  const user = await getCurrentUser();
  const locale = await getLocale();
  if (!user) redirect(`/${locale}/sign-in`);

  const [creditsData, recentGenerations, plan] = await Promise.all([
    getCreditsBalance(user.id),
    getUserRecentGenerations(user.id, 6),
    getUserPlan(user.id),
  ]);
  const [
    uploadLimits,
    activeBackendGroup,
    imageGenerationModelCatalog,
    moderationEnabled,
    imageModelPricing,
    imageModerationPricing,
  ] = await Promise.all([
    getPlanUploadLimits(plan.plan),
    getEffectiveDefaultImageBackendGroup(plan.plan),
    getImageGenerationModelCatalogForPlan(plan.plan),
    isContentModerationEnabled(),
    getRuntimeImageModelCreditPricing(),
    getRuntimeImageModerationCreditPricing(),
  ]);
  const recents = recentGenerations.map((generation) => ({
    id: generation.id,
    prompt: generation.prompt,
    status: generation.status,
    imageUrl: buildSignedStorageImageUrl(
      generation.storageKey,
      generation.storageBucket
    ),
  }));

  return (
    <GeneratePageClient
      balance={creditsData?.balance ?? 0}
      recentGenerations={recents}
      uploadLimits={uploadLimits}
      selectedBackendGroupId={activeBackendGroup?.id ?? null}
      imageGenerationModelCatalog={imageGenerationModelCatalog}
      moderationEnabled={moderationEnabled}
      imageModelPricing={imageModelPricing}
      imageModerationPricing={imageModerationPricing}
    />
  );
}
