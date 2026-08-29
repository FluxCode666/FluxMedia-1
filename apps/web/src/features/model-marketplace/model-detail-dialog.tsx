/**
 * 模型广场详情弹窗。
 *
 * 使用方是客户端模型浏览器；弹窗展示公开 DTO 中的模型 ID、简介、完整价格、视频
 * 支持参数、输入能力、配置可达性、基础设施边界和创作入口，并把复制动作交回浏览器
 * 统一反馈。Radix Dialog 负责焦点圈定、Esc 关闭及关闭后焦点恢复。
 */
"use client";

import { formatCredits } from "@repo/shared/credits/format";
import type { ModelMarketplacePublicItem } from "@repo/shared/model-marketplace";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/components/tooltip";
import { ArrowUpRight, Copy } from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { Link } from "@/i18n/routing";

import { getModelMarketplaceIconPath } from "./assets";
import { ModelMarketplaceCover } from "./model-card";
import {
  formatSupportedVideoDurations,
  getModelMarketplaceUsageHref,
} from "./model-marketplace-view-model";

/** 详情弹窗的受控状态与模型。 */
export type ModelDetailDialogProps = {
  model: ModelMarketplacePublicItem | null;
  onCopy: (modelId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * 渲染图像模型的四档完整价格。
 *
 * @param props - 图像公开 DTO。
 * @returns 1024、1K、2K、4K 四个主题化价格单元格。
 * @sideEffects 无。
 */
function ImagePricingGrid({
  model,
}: {
  model: Extract<ModelMarketplacePublicItem, { category: "image" }>;
}) {
  const t = useTranslations("ModelMarketplace");
  const rows = [
    [t("detail.imageTiers.base1024"), model.pricing.base1024Credits],
    [t("detail.imageTiers.base1k"), model.pricing.base1kCredits],
    [t("detail.imageTiers.base2k"), model.pricing.base2kCredits],
    [t("detail.imageTiers.base4k"), model.pricing.base4kCredits],
    ...(model.pricing.base8kCredits !== undefined
      ? [[t("detail.imageTiers.base8k"), model.pricing.base8kCredits] as const]
      : []),
  ] as const;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        {rows.map(([label, credits]) => (
          <div
            className="rounded-xl border border-border/70 bg-muted/25 p-4"
            key={label}
          >
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-2 font-mono text-xl font-semibold tabular-nums">
              {formatCredits(credits)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("price.credits")}
            </p>
          </div>
        ))}
      </div>
      <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        {model.supportsAutoSize === true
          ? t("detail.autoSizeSupported")
          : t("detail.autoSizeUnsupported")}
      </p>
    </div>
  );
}

/**
 * 渲染视频模型的每秒价格与支持参数。
 *
 * @param props - 视频公开 DTO。
 * @returns 每秒价格以及时长、比例、分辨率三个参数列表。
 * @sideEffects 无。
 */
function VideoPricingDetails({
  model,
}: {
  model: Extract<ModelMarketplacePublicItem, { category: "video" }>;
}) {
  const t = useTranslations("ModelMarketplace");
  const pricesByResolution =
    model.priceUnit === "per_item"
      ? model.creditsPerItemByResolution
      : model.creditsPerSecondByResolution;
  const fallbackPrice =
    model.priceUnit === "per_item"
      ? model.creditsPerItem
      : model.creditsPerSecond;
  const unitLabel =
    model.priceUnit === "per_item" ? t("price.perItem") : t("price.perSecond");
  const groups = [
    {
      label: t("detail.supportedDurations"),
      values: formatSupportedVideoDurations(model.supportedDurations),
    },
    {
      label: t("detail.supportedAspectRatios"),
      values: model.supportedAspectRatios,
    },
    {
      label: t("detail.supportedResolutions"),
      values: model.supportedResolutions,
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm text-muted-foreground">
          {t("detail.videoRate")}
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {model.supportedResolutions.map((resolution) => (
            <div className="rounded-lg border bg-muted/30 p-4" key={resolution}>
              <p className="text-xs font-medium text-muted-foreground">
                {resolution}
              </p>
              <p className="mt-2 font-mono text-xl font-semibold tabular-nums">
                {formatCredits(pricesByResolution[resolution] ?? fallbackPrice)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("price.credits")} · {unitLabel}
              </p>
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {groups.map((group) => (
          <div className="rounded-lg border p-3" key={group.label}>
            <p className="text-xs text-muted-foreground">{group.label}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {group.values.map((value) => (
                <Badge key={value} variant="secondary">
                  {value}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 展示视频模型完整输入、声音、配置可达性与基础设施限制。
 *
 * @param props - 已通过公开 DTO schema 的视频模型。
 * @returns 独立能力区块；明确区分全局支持与当前后端是否配置可达。
 * @sideEffects 无。
 * @failure 基础设施字节上限按二进制 MB 展示；非法值无法通过公开 DTO schema。
 */
function VideoCapabilityDetails({
  model,
}: {
  model: Extract<ModelMarketplacePublicItem, { category: "video" }>;
}) {
  const t = useTranslations("ModelMarketplace");
  const frameLabel =
    model.input.frames === "none"
      ? t("card.videoCapabilities.framesNone")
      : model.input.frames === "first-only"
        ? t("card.videoCapabilities.framesFirstOnly")
        : t("card.videoCapabilities.framesFirstAndLast");
  const referenceImagesLabel =
    model.input.referenceImages.maxCount === 0
      ? t("detail.capabilities.referenceImagesNone")
      : model.input.referenceImages.configurable
        ? t("detail.capabilities.referenceImagesConfigurable", {
            count: model.input.referenceImages.maxCount,
          })
        : t("detail.capabilities.referenceImagesFixed", {
            count: model.input.referenceImages.maxCount,
          });
  const audioLabel = !model.audio.supported
    ? t("card.videoCapabilities.audioNone")
    : model.audio.defaultEnabled
      ? t("card.videoCapabilities.audioDefaultOn")
      : t("card.videoCapabilities.audioOptional");
  const maxMediaInputMegabytes =
    model.infrastructureLimits.maxMediaInputBytes / (1024 * 1024);
  const rows = [
    {
      label: t("detail.capabilities.frameInputs"),
      value: frameLabel,
    },
    {
      label: t("detail.capabilities.referenceImages"),
      value: referenceImagesLabel,
    },
    {
      label: t("detail.capabilities.framesAndReferences"),
      value: model.input.framesAndReferencesMutuallyExclusive
        ? t("detail.capabilities.mutuallyExclusive")
        : t("detail.capabilities.notMutuallyExclusive"),
    },
    {
      label: t("detail.capabilities.audio"),
      value: audioLabel,
    },
  ];

  return (
    <section
      aria-labelledby="model-video-capabilities-title"
      className="mt-7 border-t border-border/70 pt-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            className="text-base font-semibold"
            id="model-video-capabilities-title"
          >
            {t("detail.capabilities.title")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("detail.capabilities.description")}
          </p>
        </div>
        <Badge variant={model.configuredReachable ? "default" : "secondary"}>
          {model.configuredReachable
            ? t("detail.capabilities.configuredReachable")
            : t("detail.capabilities.notConfiguredReachable")}
        </Badge>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div className="rounded-lg border bg-muted/20 p-3" key={row.label}>
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="mt-1.5 text-sm font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 rounded-lg border border-dashed p-3">
        <p className="text-xs font-medium text-muted-foreground">
          {t("detail.capabilities.infrastructureLimits")}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge variant="outline">
            {t("detail.capabilities.maxMediaInputCount", {
              count: model.infrastructureLimits.maxMediaInputCount,
            })}
          </Badge>
          <Badge variant="outline">
            {t("detail.capabilities.maxMediaInputSize", {
              megabytes: maxMediaInputMegabytes,
            })}
          </Badge>
        </div>
      </div>
    </section>
  );
}

/**
 * 渲染响应式模型详情 Dialog。
 *
 * @param props - 当前模型、受控开关和开关回调。
 * @returns 移动端底部大面板、桌面居中弹窗；没有模型时不挂载。
 * @sideEffects 打开时聚焦标题并锁定背景焦点；复制调用父回调，CTA 导航到创作页。
 * @failure 封面失败使用类别默认图；模型为空时安全返回 null。
 */
export function ModelDetailDialog({
  model,
  onCopy,
  open,
  onOpenChange,
}: ModelDetailDialogProps) {
  const t = useTranslations("ModelMarketplace");
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const [coverPreviewOpen, setCoverPreviewOpen] = useState(false);
  if (!model) return null;

  const categoryLabel =
    model.category === "image" ? t("categories.image") : t("categories.video");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setCoverPreviewOpen(false);
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="bottom-0 left-0 top-auto max-h-[96svh] max-w-none translate-x-0 translate-y-0 grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-t-2xl p-0 [&>button]:bg-background/90 [&>button]:opacity-100 sm:left-1/2 sm:top-1/2 sm:w-[min(1080px,calc(100vw-2rem))] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <div className="min-h-0 overflow-y-auto">
          <div className="grid border-b border-border/70 sm:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <button
              aria-label={t("detail.viewCover", {
                modelName: model.displayName,
              })}
              className="group relative block aspect-[3/2] w-full cursor-zoom-in overflow-hidden bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:aspect-auto sm:min-h-80 sm:rounded-tl-xl"
              onClick={() => setCoverPreviewOpen(true)}
              type="button"
            >
              <ModelMarketplaceCover
                model={model}
                sizes="(min-width: 640px) 400px, 100vw"
              />
              <span className="pointer-events-none absolute inset-x-3 bottom-3 rounded-md bg-background/85 px-3 py-2 text-center text-xs font-medium text-foreground opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                {t("detail.viewCoverLabel")}
              </span>
            </button>

            <div className="flex min-w-0 items-center p-5 sm:p-8">
              <DialogHeader className="w-full min-w-0 pr-8 text-left">
                <div className="mb-4 flex items-center gap-2">
                  <span className="flex size-10 items-center justify-center rounded-lg border bg-background">
                    <Image
                      unoptimized
                      alt=""
                      aria-hidden="true"
                      height={24}
                      src={getModelMarketplaceIconPath(model.iconKey)}
                      width={24}
                    />
                  </span>
                  <Badge className="rounded-full px-2.5" variant="secondary">
                    {categoryLabel}
                  </Badge>
                </div>
                <DialogTitle
                  className="font-serif text-2xl leading-tight outline-none sm:text-3xl"
                  ref={titleRef}
                  tabIndex={-1}
                >
                  {model.displayName}
                </DialogTitle>
                <div className="mt-3 flex min-w-0 items-center rounded-lg border border-border/70 bg-muted/25 p-1 pl-3">
                  <code className="min-w-0 flex-1 truncate text-xs font-medium text-foreground sm:text-sm">
                    {model.modelId}
                  </code>
                  <TooltipProvider delayDuration={250}>
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
                <DialogDescription className="mt-5 text-sm leading-6 text-muted-foreground">
                  {model.description || t("card.noDescription")}
                </DialogDescription>
              </DialogHeader>
            </div>
          </div>

          <div className="p-5 sm:p-7">
            <section aria-labelledby="model-pricing-title">
              <div className="mb-4">
                <h3
                  className="text-base font-semibold"
                  id="model-pricing-title"
                >
                  {t("detail.pricing")}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {model.category === "image"
                    ? t("price.perImage")
                    : model.priceUnit === "per_item"
                      ? t("price.perItem")
                      : t("price.perSecond")}
                </p>
              </div>
              {model.category === "image" ? (
                <ImagePricingGrid model={model} />
              ) : (
                <VideoPricingDetails model={model} />
              )}
            </section>
            {model.category === "video" ? (
              <VideoCapabilityDetails model={model} />
            ) : null}
          </div>
        </div>

        <div className="border-t border-border/70 bg-background p-4 sm:px-7 sm:py-5">
          <Button asChild className="w-full" size="lg">
            <Link href={getModelMarketplaceUsageHref(model)}>
              {t("actions.useModel")}
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </div>
      </DialogContent>
      <Dialog open={coverPreviewOpen} onOpenChange={setCoverPreviewOpen}>
        <DialogContent
          aria-describedby="model-cover-preview-description"
          className="h-[min(90svh,900px)] w-[min(96vw,1280px)] max-w-none border-border/70 bg-black/95 p-2 sm:rounded-xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("detail.coverPreviewTitle")}</DialogTitle>
            <DialogDescription id="model-cover-preview-description">
              {t("detail.coverPreviewDescription", {
                modelName: model.displayName,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black">
            <ModelMarketplaceCover
              model={model}
              sizes="96vw"
              className="object-contain"
            />
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
