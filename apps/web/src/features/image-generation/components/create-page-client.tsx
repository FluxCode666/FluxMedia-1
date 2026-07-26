/**
 * 媒体创作页客户端容器。
 *
 * 职责：在图片与视频两条独立媒体链路之间切换，并维护页面内余额展示。
 * Chat、Agent、waterfall、PPT、PSD 和会话持久化均不属于目标产品边界。
 */

"use client";

import { formatCredits } from "@repo/shared/credits/format";
import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { Images, Video } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import {
  parseModelPreselectionIntent,
  removePreselectionParams,
  resolveAuthorizedImageSelection,
  resolveVideoInitialSelection,
} from "@/features/image-generation/model-preselection";
import type { VideoPricingInfo } from "@/features/image-generation/video-operations";

import { ImageCreatePanel } from "./image-create-panel";
import { VideoCreatePanel } from "./video-create-panel";

type RecentGeneration = {
  id: string;
  prompt: string;
  status: string;
  imageUrl: string | null;
};

interface CreatePageClientProps {
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
  videoPricing: VideoPricingInfo;
}

type CreateMediaMode = "image" | "video";

/**
 * 渲染只包含图片和视频的创作页。
 *
 * @param props 服务端已授权的模型目录、计价、上传限制和近期媒体。
 * @returns 媒体创作入口；页面内扣费只更新展示余额，服务端账本仍是唯一真相。
 */
export function CreatePageClient({
  balance: initialBalance,
  recentGenerations,
  uploadLimits,
  selectedBackendGroupId,
  imageGenerationModelCatalog,
  moderationEnabled,
  imageModelPricing,
  imageModerationPricing,
  videoPricing,
}: CreatePageClientProps) {
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
    };
  });
  const [activeMode, setActiveMode] = useState<CreateMediaMode>(
    initialPreselection.intent?.category === "video" ? "video" : "image"
  );
  const hasConsumedPreselection = useRef(false);

  useEffect(() => {
    if (
      hasConsumedPreselection.current ||
      !initialPreselection.hasQueryParams
    ) {
      return;
    }
    hasConsumedPreselection.current = true;

    const selectionIsAvailable =
      initialPreselection.intent?.category === "image"
        ? initialPreselection.imageSelection !== null
        : initialPreselection.intent?.category === "video"
          ? initialPreselection.videoSelection !== null
          : false;
    if (!selectionIsAvailable) {
      toast.error("该模型当前不可用，已保留安全默认模型");
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

  /** 收窄媒体标签切换，忽略组件交付的未知值。 */
  const changeActiveMode = (value: string) => {
    if (value === "image" || value === "video") setActiveMode(value);
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>媒体创作</CardTitle>
            <CardDescription className="mt-1">
              图片与视频统一从当前后端分组的显式模型能力中调度。
            </CardDescription>
          </div>
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            当前余额：{formatCredits(balance)} 积分
          </div>
        </CardHeader>
      </Card>

      <Tabs
        value={activeMode}
        onValueChange={changeActiveMode}
        className="space-y-6"
      >
        <TabsList className="grid w-full max-w-sm grid-cols-2">
          <TabsTrigger value="image" className="gap-2">
            <Images className="size-4" />
            图片
          </TabsTrigger>
          <TabsTrigger value="video" className="gap-2">
            <Video className="size-4" />
            视频
          </TabsTrigger>
        </TabsList>

        <TabsContent value="image">
          <ImageCreatePanel
            balance={balance}
            catalog={imageGenerationModelCatalog}
            imageModelPricing={imageModelPricing}
            imageModerationPricing={imageModerationPricing}
            maxFileSizeBytes={uploadLimits.maxFileSizeBytes}
            moderationEnabled={moderationEnabled}
            onCreditsConsumed={consumeDisplayedCredits}
            recent={recentGenerations}
            selectedBackendGroupId={selectedBackendGroupId}
            initialSelection={initialPreselection.imageSelection}
          />
        </TabsContent>

        <TabsContent value="video">
          <Card>
            <CardContent className="pt-6">
              <VideoCreatePanel
                initialSelection={initialPreselection.videoSelection}
                recent={recentGenerations}
                pricing={videoPricing}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
