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
} from "@/features/image-backend-pool/service";
import { CreatePageClient } from "@/features/image-generation/components/create-page-client";
import {
  getRuntimeImageModelCreditPricing,
  getRuntimeImageModerationCreditPricing,
} from "@/features/image-generation/pricing-settings";
import { getUserRecentGenerations } from "@/features/image-generation/queries";
import { getVideoPricingForUser } from "@/features/image-generation/video-operations";

export default async function CreatePage() {
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
  ] = await Promise.all([
    getPlanUploadLimits(plan.plan),
    getEffectiveDefaultImageBackendGroup(plan.plan),
    getImageGenerationModelCatalogForPlan(plan.plan),
    isContentModerationEnabled(),
  ]);
  const [imageModelPricing, imageModerationPricing, videoPricing] =
    await Promise.all([
      getRuntimeImageModelCreditPricing(),
      getRuntimeImageModerationCreditPricing(),
      getVideoPricingForUser({
        userId: user.id,
        group: activeBackendGroup?.videoCreditOverrides,
      }),
    ]);
  const balance = creditsData?.balance || 0;

  const recents = recentGenerations.map((g) => ({
    id: g.id,
    prompt: g.prompt,
    status: g.status,
    imageUrl: buildSignedStorageImageUrl(g.storageKey, g.storageBucket),
  }));

  return (
    <CreatePageClient
      balance={balance}
      recentGenerations={recents}
      uploadLimits={uploadLimits}
      selectedBackendGroupId={activeBackendGroup?.id ?? null}
      imageGenerationModelCatalog={imageGenerationModelCatalog}
      moderationEnabled={moderationEnabled}
      imageModelPricing={imageModelPricing}
      imageModerationPricing={imageModerationPricing}
      videoPricing={videoPricing}
    />
  );
}
