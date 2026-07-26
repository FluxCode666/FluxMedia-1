/**
 * 简易生图页客户端容器。
 *
 * 职责：消费服务端授权的模型目录，处理模型广场的一次性图片预选，并维护当前页面
 * 的余额展示。视频、对话、Agent、waterfall、PPT、PSD 与会话持久化不属于本页面。
 */

"use client";

import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import {
  parseModelPreselectionIntent,
  removePreselectionParams,
  resolveAuthorizedImageSelection,
} from "@/features/image-generation/model-preselection";

import { ImageCreatePanel } from "./image-create-panel";

type RecentGeneration = {
  id: string;
  prompt: string;
  status: string;
  imageUrl: string | null;
};

interface GeneratePageClientProps {
  balance: number;
  recentGenerations: RecentGeneration[];
  uploadLimits: {
    maxFileSizeBytes: number;
    maxUploadBytes: number;
  };
  selectedBackendGroupId: string | null;
  imageGenerationModelCatalog: ImageGenerationModelCatalog;
  moderationEnabled: boolean;
  imageModelPricing: ImageCreditOverrides;
  imageModerationPricing: {
    imageModerationCredits: number;
    textModerationCredits: number;
  };
}

/**
 * 渲染旧版统一视觉的简易生图页。
 *
 * @param props 服务端已授权的模型目录、计价、上传限制和近期图片。
 * @returns 单一生图工作区；页面内扣费只更新展示余额，服务端账本仍是唯一真相。
 * @sideEffects 首次加载可消费模型广场查询参数并替换当前浏览器 URL。
 * @failure 非法或未授权的模型预选会显示提示，并继续使用安全默认模型。
 */
export function GeneratePageClient({
  balance: initialBalance,
  recentGenerations,
  uploadLimits,
  selectedBackendGroupId,
  imageGenerationModelCatalog,
  moderationEnabled,
  imageModelPricing,
  imageModerationPricing,
}: GeneratePageClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [balance, setBalance] = useState(initialBalance);
  const [initialPreselection] = useState(() => {
    const intent = parseModelPreselectionIntent(searchParams);
    return {
      hasQueryParams:
        searchParams.getAll("category").length > 0 ||
        searchParams.getAll("model").length > 0,
      intent,
      imageSelection:
        intent?.category === "image"
          ? resolveAuthorizedImageSelection({
              catalog: imageGenerationModelCatalog,
              currentGroupId: selectedBackendGroupId,
              modelId: intent.modelId,
            })
          : null,
    };
  });
  const hasConsumedPreselection = useRef(false);

  useEffect(() => {
    if (
      hasConsumedPreselection.current ||
      !initialPreselection.hasQueryParams
    ) {
      return;
    }
    hasConsumedPreselection.current = true;

    if (!initialPreselection.imageSelection) {
      toast.error("该图片模型当前不可用，已保留安全默认模型");
    }

    router.replace(removePreselectionParams(new URL(window.location.href)), {
      scroll: false,
    });
  }, [initialPreselection, router]);

  /** 按服务端返回的实际扣费更新页面余额，不允许显示负数。 */
  const consumeDisplayedCredits = (credits: number) => {
    if (!Number.isFinite(credits) || credits <= 0) return;
    setBalance((current) => Math.max(0, current - credits));
  };

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-12">
      <ImageCreatePanel
        balance={balance}
        catalog={imageGenerationModelCatalog}
        imageModelPricing={imageModelPricing}
        imageModerationPricing={imageModerationPricing}
        maxFileSizeBytes={uploadLimits.maxFileSizeBytes}
        maxUploadBytes={uploadLimits.maxUploadBytes}
        moderationEnabled={moderationEnabled}
        onCreditsConsumed={consumeDisplayedCredits}
        recent={recentGenerations}
        selectedBackendGroupId={selectedBackendGroupId}
        initialSelection={initialPreselection.imageSelection}
      />
    </div>
  );
}
