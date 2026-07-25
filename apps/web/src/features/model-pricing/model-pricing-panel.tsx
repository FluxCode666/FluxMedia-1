"use client";

import {
  ADOBE_VIDEO_PRICING_FAMILIES,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  formatAdobeModelIdForDisplay,
  globalVideoModelCreditsPerSecondSchema,
} from "@repo/shared/adobe";
/**
 * 全局模型计费配置面板。
 *
 * 使用方：管理员设置页的独立“模型计费”页签。它只管理全局必填价格，分组价格覆盖仍在
 * 生图后端池的分组页编辑，避免账号池、分组与全局三个入口互相覆盖。
 */
import { ADOBE_IMAGE_MODEL_IDS } from "@repo/shared/adobe/enabled-models";
import {
  createDefaultGlobalImageCreditOverrides,
  GLOBAL_DEFAULT_IMAGE_PRICING_MODEL,
  globalImageCreditOverridesSchema,
  normalizeImagePricingModelId,
} from "@repo/shared/image-backend/group-image-pricing";
import {
  getGlobalModelPricingAction,
  updateGlobalModelPricingAction,
} from "@repo/shared/system-settings/actions";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Loader2, Save } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  type ImageCreditPricingDraft,
  ImageCreditPricingEditor,
  imageCreditOverridesToDraft,
  imageCreditPricingDraftToOverrides,
  updateImageCreditPricingDraft,
} from "@/features/image-backend-pool/image-credit-pricing-editor";
import {
  updateVideoCreditPricingDraft,
  type VideoCreditPricingDraft,
  VideoCreditPricingEditor,
  videoCreditOverridesToDraft,
  videoCreditPricingDraftToOverrides,
} from "@/features/image-backend-pool/video-credit-pricing-editor";

const BASE_GLOBAL_IMAGE_PRICING_MODELS = [
  GLOBAL_DEFAULT_IMAGE_PRICING_MODEL,
  ...ADOBE_IMAGE_MODEL_IDS.flatMap((model) => {
    const normalized = normalizeImagePricingModelId(model);
    return normalized ? [normalized] : [];
  }),
];

/** 渲染并保存全局必填模型价格，不直接读取或修改分组元数据。 */
export function ModelPricingPanel() {
  const [imageDraft, setImageDraft] = useState<ImageCreditPricingDraft>(() =>
    imageCreditOverridesToDraft(createDefaultGlobalImageCreditOverrides())
  );
  const [videoDraft, setVideoDraft] = useState<VideoCreditPricingDraft>(() =>
    videoCreditOverridesToDraft(
      ADOBE_VIDEO_PRICING_FAMILIES,
      DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND
    )
  );

  const { execute: loadPricing, isPending: isLoading } = useAction(
    getGlobalModelPricingAction,
    {
      onSuccess: ({ data }) => {
        if (!data) return;
        setImageDraft(imageCreditOverridesToDraft(data.image));
        setVideoDraft(
          videoCreditOverridesToDraft(
            ADOBE_VIDEO_PRICING_FAMILIES,
            data.videoCreditsPerSecond
          )
        );
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载全局模型计费配置失败"),
    }
  );
  const { execute: savePricing, isPending: isSaving } = useAction(
    updateGlobalModelPricingAction,
    {
      onSuccess: () => {
        toast.success("全局模型计费配置已保存");
        loadPricing();
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "保存全局模型计费配置失败"),
    }
  );

  useEffect(() => {
    loadPricing();
  }, [loadPricing]);

  const pendingImagePricing = useMemo(
    () => imageCreditPricingDraftToOverrides(imageDraft),
    [imageDraft]
  );
  const globalImagePricingModels = useMemo(
    () =>
      Array.from(
        new Set([
          ...BASE_GLOBAL_IMAGE_PRICING_MODELS,
          ...Object.keys(imageDraft),
        ])
      ),
    [imageDraft]
  );
  const pendingVideoPricing = useMemo(
    () => videoCreditPricingDraftToOverrides(videoDraft),
    [videoDraft]
  );

  /** 先在客户端提示必填项，再由 UOL schema 在服务端做最终财务校验。 */
  const handleSave = () => {
    const imageResult =
      globalImageCreditOverridesSchema.safeParse(pendingImagePricing);
    const videoResult =
      globalVideoModelCreditsPerSecondSchema.safeParse(pendingVideoPricing);
    if (!imageResult.success || !videoResult.success) {
      toast.error(
        "请为每个内置图像模型填满四档价格，并为每个视频模型填写每秒积分"
      );
      return;
    }
    savePricing({
      image: imageResult.data,
      videoCreditsPerSecond: videoResult.data,
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>全局模型计费配置</CardTitle>
          <CardDescription>
            全局价格为必填默认值。分组可按模型和档位覆盖；分组未填写时，图像和视频均使用这里的价格。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">图像模型固定价格</h3>
              <p className="text-xs text-muted-foreground">
                每个模型都必须设置 1024、1K、2K、4K
                四档固定积分。实际扣费按输出像素归档，再加上审核费用。
              </p>
            </div>
            <ImageCreditPricingEditor
              models={globalImagePricingModels}
              draft={imageDraft}
              inheritanceLabel="全局配置必填"
              getModelLabel={(model) =>
                model === GLOBAL_DEFAULT_IMAGE_PRICING_MODEL
                  ? "其他或自定义图像模型（全局默认）"
                  : formatAdobeModelIdForDisplay(model)
              }
              resolveInheritedPricing={() => ({
                base1024Credits: 1.27,
                base1kCredits: 1.27,
                base2kCredits: 5.07,
                base4kCredits: 10,
              })}
              onChange={(model, field, value) =>
                setImageDraft((current) =>
                  updateImageCreditPricingDraft(current, model, field, value)
                )
              }
            />
          </div>

          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">视频模型每秒积分</h3>
              <p className="text-xs text-muted-foreground">
                每个模型族必须设置每秒积分；一次视频的基础积分为模型每秒积分乘以实际时长。
              </p>
            </div>
            <VideoCreditPricingEditor
              families={ADOBE_VIDEO_PRICING_FAMILIES}
              draft={videoDraft}
              inheritanceLabel="全局配置必填"
              resolveInheritedPrice={(family) =>
                DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND[family] ?? 30
              }
              onChange={(family, value) =>
                setVideoDraft((current) =>
                  updateVideoCreditPricingDraft(current, family, value)
                )
              }
            />
          </div>

          <Button disabled={isLoading || isSaving} onClick={handleSave}>
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            保存全局模型计费配置
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
