/**
 * 图片与视频生成菜单页路由。
 *
 * 使用方：控制台侧边栏的生成入口。
 * 关键依赖：服务端装配用户额度、运营模型目录、上传限制、计价和近期图片，
 * 客户端渲染旧版统一视觉的图片与视频工作区。
 */
import { getCurrentUser } from "@repo/shared/auth/server";
import { getCreditsBalance } from "@repo/shared/credits/core";
import { getMediaLimitDefaults } from "@repo/shared/image-generation/media-limit-service";
import { isContentModerationEnabled } from "@repo/shared/moderation";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import {
  getEffectiveDefaultImageBackendGroup,
  getImageGenerationModelCatalog,
} from "@/features/image-backend-pool/catalog-service";
import { GeneratePageClient } from "@/features/image-generation/components/generate-page-client";
import {
  getRuntimeImageModelCreditPricing,
  getRuntimeImageModerationCreditPricing,
} from "@/features/image-generation/pricing-settings";
import { getUserRecentGenerations } from "@/features/image-generation/queries";

/**
 * 渲染独立的图片与视频生成页面。
 *
 * @returns 已完成鉴权和运营目录收窄的简易生图页面。
 * @sideEffects 读取账户、系统配置和近期生成记录；未登录时跳转登录页。
 * @failure 底层必需数据读取失败时交由 Next.js 错误边界处理，不伪造空授权目录。
 */
export default async function GeneratePage() {
  const user = await getCurrentUser();
  const locale = await getLocale();
  if (!user) redirect(`/${locale}/sign-in`);

  const [creditsData, recentGenerations] = await Promise.all([
    getCreditsBalance(user.id),
    getUserRecentGenerations(user.id, 6),
  ]);
  const [
    mediaLimits,
    activeBackendGroup,
    imageGenerationModelCatalog,
    moderationEnabled,
    imageModelPricing,
    imageModerationPricing,
  ] = await Promise.all([
    getMediaLimitDefaults(),
    getEffectiveDefaultImageBackendGroup(),
    getImageGenerationModelCatalog(),
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
      uploadLimits={{
        maxFileSizeBytes: mediaLimits.maxFileSizeBytes,
        maxUploadBytes: mediaLimits.maxUploadSizeBytes,
        maxEditImages: mediaLimits.maxEditReferenceImages,
      }}
      selectedBackendGroupId={activeBackendGroup?.id ?? null}
      imageGenerationModelCatalog={imageGenerationModelCatalog}
      moderationEnabled={moderationEnabled}
      imageModelPricing={imageModelPricing}
      imageModerationPricing={imageModerationPricing}
    />
  );
}
