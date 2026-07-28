/**
 * 模型广场详情弹窗。
 *
 * 使用方是客户端模型浏览器；弹窗展示公开 DTO 中的模型 ID、简介、完整价格、视频
 * 支持参数和创作入口，并把复制动作交回浏览器统一反馈。Radix Dialog 负责焦点圈定、
 * Esc 关闭及关闭后焦点恢复。
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
import { useRef } from "react";

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
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                {formatCredits(
                  model.creditsPerSecondByResolution[resolution] ??
                    model.creditsPerSecond
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("price.credits")} · {t("price.perSecond")}
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
  if (!model) return null;

  const categoryLabel =
    model.category === "image" ? t("categories.image") : t("categories.video");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bottom-0 left-0 top-auto max-h-[92svh] max-w-none translate-x-0 translate-y-0 grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-t-2xl p-0 [&>button]:bg-background/90 [&>button]:opacity-100 sm:left-1/2 sm:top-1/2 sm:w-[min(880px,calc(100vw-2rem))] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <div className="min-h-0 overflow-y-auto">
          <div className="grid border-b border-border/70 sm:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <div className="relative aspect-[3/2] overflow-hidden bg-muted sm:aspect-auto sm:min-h-72 sm:rounded-tl-xl">
              <ModelMarketplaceCover
                model={model}
                sizes="(min-width: 640px) 400px, 100vw"
              />
            </div>

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
                    : t("price.perSecond")}
                </p>
              </div>
              {model.category === "image" ? (
                <ImagePricingGrid model={model} />
              ) : (
                <VideoPricingDetails model={model} />
              )}
            </section>
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
    </Dialog>
  );
}
