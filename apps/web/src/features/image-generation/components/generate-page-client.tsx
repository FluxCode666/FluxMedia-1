/**
 * 简易生图页客户端容器。
 *
 * 职责：消费服务端授权的模型目录，处理模型广场的一次性图片或视频预选，并维护
 * 当前页面的余额展示。对话、Agent、waterfall、PPT、PSD 与会话持久化不属于本页面。
 */

"use client";

import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import {
  parseModelPreselectionIntent,
  removePreselectionParams,
  resolveAuthorizedImageSelection,
  resolveVideoInitialSelection,
} from "@/features/image-generation/model-preselection";
import {
  hasReferenceHandoffParams,
  parseReferenceHandoffIntent,
  removeReferenceHandoffParams,
} from "@/features/image-generation/reference-handoff";

import { ImageCreatePanel } from "./image-create-panel";
import { VideoCreatePanel } from "./video-create-panel";

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
    maxEditImages: number;
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
 * 渲染旧版统一视觉的图片与视频创作页。
 *
 * @param props 服务端已授权的模型目录、计价、上传限制和近期图片。
 * @returns 图片与视频两个独立工作区；页面内扣费只更新展示余额，服务端账本仍是唯一真相。
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
      videoSelection:
        intent?.category === "video"
          ? resolveVideoInitialSelection(intent.modelId)
          : null,
      hasReferenceQuery: hasReferenceHandoffParams(searchParams),
      reference: parseReferenceHandoffIntent(searchParams),
    };
  });
  const hasProcessedInitialQueries = useRef(false);

  useEffect(() => {
    if (hasProcessedInitialQueries.current) return;
    hasProcessedInitialQueries.current = true;

    let currentUrl = new URL(window.location.href);
    let shouldReplaceUrl = false;
    if (initialPreselection.hasQueryParams) {
      if (
        initialPreselection.intent?.category === "image" &&
        !initialPreselection.imageSelection
      ) {
        toast.error("该图片模型当前不可用，已保留安全默认模型");
      } else if (
        initialPreselection.intent?.category === "video" &&
        !initialPreselection.videoSelection
      ) {
        toast.error("该视频模型无效，已保留安全默认模型");
      } else if (!initialPreselection.intent) {
        toast.error("模型预选参数无效，已保留安全默认模型");
      }
      currentUrl = new URL(
        removePreselectionParams(currentUrl),
        currentUrl.origin
      );
      shouldReplaceUrl = true;
    }
    if (
      initialPreselection.hasReferenceQuery &&
      !initialPreselection.reference
    ) {
      toast.error("图库参考图参数无效，请返回图库后重试");
      currentUrl = new URL(
        removeReferenceHandoffParams(currentUrl),
        currentUrl.origin
      );
      shouldReplaceUrl = true;
    }

    if (!shouldReplaceUrl) return;
    router.replace(
      `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
      { scroll: false }
    );
  }, [initialPreselection, router]);

  /** 在图片面板完成加载尝试后清理一次性交接参数，避免刷新时重复添加。 */
  const consumeInitialReference = useCallback(() => {
    router.replace(
      removeReferenceHandoffParams(new URL(window.location.href)),
      { scroll: false }
    );
  }, [router]);

  /** 按服务端返回的实际扣费更新页面余额，不允许显示负数。 */
  const consumeDisplayedCredits = (credits: number) => {
    if (!Number.isFinite(credits) || credits <= 0) return;
    setBalance((current) => Math.max(0, current - credits));
  };

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-12">
      <Tabs
        defaultValue={initialPreselection.videoSelection ? "video" : "image"}
      >
        <TabsList
          aria-label="生成类型"
          className="mb-4 border border-border bg-muted/40"
        >
          <TabsTrigger value="image">图片</TabsTrigger>
          <TabsTrigger value="video">视频</TabsTrigger>
        </TabsList>
        <TabsContent value="image" className="mt-0">
          <ImageCreatePanel
            balance={balance}
            catalog={imageGenerationModelCatalog}
            imageModelPricing={imageModelPricing}
            imageModerationPricing={imageModerationPricing}
            maxFileSizeBytes={uploadLimits.maxFileSizeBytes}
            maxUploadBytes={uploadLimits.maxUploadBytes}
            maxEditImages={uploadLimits.maxEditImages}
            moderationEnabled={moderationEnabled}
            onCreditsConsumed={consumeDisplayedCredits}
            recent={recentGenerations}
            selectedBackendGroupId={selectedBackendGroupId}
            initialSelection={initialPreselection.imageSelection}
            initialReference={initialPreselection.reference}
            onInitialReferenceConsumed={consumeInitialReference}
          />
        </TabsContent>
        <TabsContent value="video" className="mt-0">
          <VideoCreatePanel
            initialSelection={initialPreselection.videoSelection}
            recent={recentGenerations}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
