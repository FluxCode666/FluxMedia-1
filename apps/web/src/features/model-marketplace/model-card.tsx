/**
 * 公开模型广场的模型卡片与媒体资产组件。
 *
 * 使用方是模型广场网格和详情弹窗；卡片严格消费公开 DTO，只展示 3:2 封面、类别、
 * 品牌图标、可复制模型 ID、最低价格、视频输入摘要与详情入口，不读取管理配置或用户权限。
 */
"use client";

import { formatCredits } from "@repo/shared/credits/format";
import type { ModelMarketplacePublicItem } from "@repo/shared/model-marketplace";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/components/tooltip";
import { ArrowRight, Copy } from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import {
  getDefaultModelMarketplaceCoverPath,
  getModelMarketplaceIconPath,
} from "./assets";

/** 模型卡片对外暴露的交互。 */
export type ModelMarketplaceCardProps = {
  model: ModelMarketplacePublicItem;
  eagerCover?: boolean;
  onCopy: (modelId: string) => void;
  onViewDetails: (model: ModelMarketplacePublicItem) => void;
};

type PublicVideoModel = Extract<
  ModelMarketplacePublicItem,
  { category: "video" }
>;

/**
 * 渲染视频模型的帧、参考图和声音能力摘要。
 *
 * @param props - 严格公开视频 DTO。
 * @returns 三个可换行的短文本标签，完整限制仍在详情弹窗展示。
 * @sideEffects 无。
 * @failure DTO 已由服务端 schema 校验；未知帧枚举无法进入该组件。
 */
function VideoCapabilitySummary({ model }: { model: PublicVideoModel }) {
  const t = useTranslations("ModelMarketplace");
  const frameLabel =
    model.input.frames === "none"
      ? t("card.videoCapabilities.framesNone")
      : model.input.frames === "first-only"
        ? t("card.videoCapabilities.framesFirstOnly")
        : t("card.videoCapabilities.framesFirstAndLast");
  const referenceImagesLabel =
    model.input.referenceImages.maxCount === 0
      ? t("card.videoCapabilities.referenceImagesNone")
      : t("card.videoCapabilities.referenceImagesMax", {
          count: model.input.referenceImages.maxCount,
        });
  const audioLabel = !model.audio.supported
    ? t("card.videoCapabilities.audioNone")
    : model.audio.defaultEnabled
      ? t("card.videoCapabilities.audioDefaultOn")
      : t("card.videoCapabilities.audioOptional");

  return (
    <div className="mt-4 flex flex-wrap gap-1.5">
      {[frameLabel, referenceImagesLabel, audioLabel].map((label) => (
        <Badge className="max-w-full font-normal" key={label} variant="outline">
          <span className="truncate">{label}</span>
        </Badge>
      ))}
    </div>
  );
}

/**
 * 渲染带一次性本地兜底的 3:2 模型封面。
 *
 * @param props - 公开模型、图片尺寸提示和可选样式。
 * @returns 直接加载第一方 WebP 的固定比例媒体；失败后只切换一次类别默认图。
 * @sideEffects 浏览器加载图片；自定义封面失败时更新一次本地 src 状态。
 * @failure 默认封面也失败时保持失败状态，不循环更新或请求第三方地址。
 */
export function ModelMarketplaceCover({
  model,
  sizes,
  className = "",
  eager = false,
}: {
  model: ModelMarketplacePublicItem;
  sizes: string;
  className?: string;
  eager?: boolean;
}) {
  const fallbackCover = getDefaultModelMarketplaceCoverPath(model.category);
  const [source, setSource] = useState(model.coverUrl);

  useEffect(() => {
    setSource(model.coverUrl);
  }, [model.coverUrl]);

  /** 自定义封面失败时切换到对应类别默认图，默认图失败不再循环。 */
  const handleImageError = () => {
    if (source !== fallbackCover) setSource(fallbackCover);
  };

  return (
    <Image
      fill
      unoptimized
      alt={model.displayName}
      className={`object-cover ${className}`}
      loading={eager ? "eager" : "lazy"}
      onError={handleImageError}
      sizes={sizes}
      src={source}
    />
  );
}

/**
 * 渲染单个公开模型卡片。
 *
 * @param props - 公开 DTO 与复制、打开详情回调。
 * @returns 当前营销主题下可键盘操作的模型摘要卡片。
 * @sideEffects 点击复制或详情时调用父组件回调；图片错误仅触发本地封面兜底。
 * @failure 复制失败由父组件统一反馈，卡片本身保持可用。
 */
export function ModelMarketplaceCard({
  model,
  eagerCover = false,
  onCopy,
  onViewDetails,
}: ModelMarketplaceCardProps) {
  const t = useTranslations("ModelMarketplace");
  const categoryLabel =
    model.category === "image" ? t("categories.image") : t("categories.video");
  const priceUnit =
    model.category === "image" ? t("price.perImage") : t("price.perSecond");

  return (
    <article className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg">
      <div className="relative aspect-[3/2] overflow-hidden bg-muted">
        <ModelMarketplaceCover
          model={model}
          sizes="(min-width: 1280px) 24vw, (min-width: 768px) 36vw, 92vw"
          className="transition-transform duration-500 group-hover:scale-[1.025]"
          eager={eagerCover}
        />
      </div>

      <div className="flex flex-1 flex-col p-5">
        <Badge variant="secondary" className="w-fit rounded-full px-2.5">
          {categoryLabel}
        </Badge>

        <div className="mt-4 flex min-w-0 items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
            <Image
              unoptimized
              alt=""
              aria-hidden="true"
              height={22}
              src={getModelMarketplaceIconPath(model.iconKey)}
              width={22}
            />
          </span>
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="min-w-0 truncate font-mono text-sm font-medium text-foreground">
                  {model.modelId}
                </p>
              </TooltipTrigger>
              <TooltipContent>{model.modelId}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  aria-label={t("actions.copyModelId", {
                    modelId: model.modelId,
                  })}
                  className="size-8 shrink-0 text-muted-foreground"
                  onClick={() => onCopy(model.modelId)}
                  size="icon"
                  variant="ghost"
                >
                  <Copy className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("actions.copy")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <h2 className="mt-4 font-serif text-xl font-medium leading-tight">
          {model.displayName}
        </h2>
        <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
          {model.description || t("card.noDescription")}
        </p>
        {model.category === "video" ? (
          <VideoCapabilitySummary model={model} />
        ) : null}

        <div className="mt-5 border-t border-border/70 pt-4">
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
            {t("price.startingAt")}
          </p>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-2xl font-semibold tabular-nums">
              {formatCredits(model.minimumCredits)}
            </span>
            <span className="text-sm text-muted-foreground">
              {t("price.credits")} · {priceUnit}
            </span>
          </div>
        </div>

        <Button
          type="button"
          className="mt-5 w-full justify-between"
          onClick={() => onViewDetails(model)}
          variant="outline"
        >
          {t("actions.viewDetails")}
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </article>
  );
}
