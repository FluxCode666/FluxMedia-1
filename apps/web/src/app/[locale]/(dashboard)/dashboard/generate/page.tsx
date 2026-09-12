/**
 * 图片与视频生成菜单页路由。
 *
 * 使用方：控制台侧边栏的生成入口。
 * 关键依赖：服务端装配用户额度、运营模型目录、上传限制、计价和近期图片，
 * 客户端渲染旧版统一视觉的图片与视频工作区。
 */
import { getCurrentUser } from "@repo/shared/auth/server";
import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import { GeneratePageClient } from "@/features/image-generation/components/generate-page-client";
import { requestGoJson } from "@/server/go-backend-client";

type GeneratePageData = {
  balance: number;
  recentGenerations: Array<{ id: string; prompt: string; status: string; imageUrl: string | null }>;
  uploadLimits: { maxFileSizeBytes: number; maxUploadBytes: number; maxEditImages: number };
  selectedBackendGroupId: string | null;
  imageGenerationModelCatalog: ImageGenerationModelCatalog;
  moderationEnabled: boolean;
  imageModelPricing: ImageCreditOverrides;
  imageModerationPricing: { imageModerationCredits: number; textModerationCredits: number };
};

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

  const pageData = await requestGoJson<GeneratePageData>(
    "/api/image-generation/page-data"
  );

  return (
    <GeneratePageClient
      balance={pageData.balance}
      recentGenerations={pageData.recentGenerations}
      uploadLimits={pageData.uploadLimits}
      selectedBackendGroupId={pageData.selectedBackendGroupId}
      imageGenerationModelCatalog={pageData.imageGenerationModelCatalog}
      moderationEnabled={pageData.moderationEnabled}
      imageModelPricing={pageData.imageModelPricing}
      imageModerationPricing={pageData.imageModerationPricing}
    />
  );
}
