/**
 * 模型广场详情弹窗。
 *
 * 使用方是客户端模型浏览器；弹窗展示公开 DTO 中的简介、完整价格、视频支持参数和
 * 一次性创作入口。Radix Dialog 负责焦点圈定、Esc 关闭及关闭后焦点恢复。
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
import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/routing";

import { getModelMarketplaceIconPath } from "./assets";
import { ModelMarketplaceCover } from "./model-card";
import { getModelMarketplaceUsageHref } from "./model-marketplace-view-model";

/** 详情弹窗的受控状态与模型。 */
export type ModelDetailDialogProps = {
  model: ModelMarketplacePublicItem | null;
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
        <div className="rounded-lg border bg-muted/30 p-3" key={label}>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 font-mono text-base font-semibold tabular-nums">
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
      values: model.supportedDurations.map((duration) => `${duration}s`),
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
      <div className="flex items-end justify-between rounded-lg border bg-muted/30 p-4">
        <p className="text-sm text-muted-foreground">{t("detail.videoRate")}</p>
        <p className="font-mono text-xl font-semibold tabular-nums">
          {formatCredits(model.creditsPerSecond)}
          <span className="ml-1.5 font-sans text-xs font-normal text-muted-foreground">
            {t("price.credits")} · {t("price.perSecond")}
          </span>
        </p>
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
 * @sideEffects 打开时锁定背景焦点；CTA 导航到受保护创作页。
 * @failure 封面失败使用类别默认图；模型为空时安全返回 null。
 */
export function ModelDetailDialog({
  model,
  open,
  onOpenChange,
}: ModelDetailDialogProps) {
  const t = useTranslations("ModelMarketplace");
  if (!model) return null;

  const categoryLabel =
    model.category === "image" ? t("categories.image") : t("categories.video");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bottom-0 left-0 top-auto max-h-[92svh] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-t-2xl p-0 [&>button]:bg-background/90 [&>button]:opacity-100 sm:left-1/2 sm:top-1/2 sm:w-[min(760px,calc(100vw-2rem))] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-xl">
        <div className="relative aspect-[3/2] max-h-72 overflow-hidden bg-muted sm:rounded-t-xl">
          <ModelMarketplaceCover
            model={model}
            sizes="(min-width: 640px) 760px, 100vw"
          />
        </div>

        <div className="space-y-6 p-5 sm:p-7">
          <DialogHeader className="pr-8 text-left">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-lg border bg-background">
                <Image
                  unoptimized
                  alt=""
                  aria-hidden="true"
                  height={22}
                  src={getModelMarketplaceIconPath(model.iconKey)}
                  width={22}
                />
              </span>
              <Badge variant="secondary">{categoryLabel}</Badge>
            </div>
            <DialogTitle className="font-serif text-2xl leading-tight">
              {model.displayName}
            </DialogTitle>
            <DialogDescription className="break-all font-mono text-xs">
              {model.defaultModelId}
            </DialogDescription>
          </DialogHeader>

          <section aria-labelledby="model-description-title">
            <h3 className="text-sm font-medium" id="model-description-title">
              {t("detail.description")}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {model.description || t("card.noDescription")}
            </p>
          </section>

          <section aria-labelledby="model-pricing-title">
            <h3 className="mb-3 text-sm font-medium" id="model-pricing-title">
              {t("detail.pricing")}
            </h3>
            {model.category === "image" ? (
              <ImagePricingGrid model={model} />
            ) : (
              <VideoPricingDetails model={model} />
            )}
          </section>

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
