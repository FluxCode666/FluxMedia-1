/**
 * 模型广场桌面侧栏与移动 Sheet 共用的筛选控件。
 *
 * 使用方是模型广场客户端浏览器；类别与厂商均消费公开 DTO 派生状态，品牌图标复用
 * 模型广场第一方资产，不自行猜测或请求第三方资源。
 */
"use client";

import type { ModelMarketplaceIconKey } from "@repo/shared/model-marketplace";
import { Label } from "@repo/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@repo/ui/components/radio-group";
import { useTranslations } from "next-intl";

import { ModelBrandIcon } from "./model-brand-icon";
import {
  type ModelMarketplaceCategoryFilter,
  type ModelMarketplaceProviderFilter,
  parseModelMarketplaceCategoryFilter,
  parseModelMarketplaceProviderFilter,
} from "./model-marketplace-view-model";

/** 共用筛选控件的受控状态。 */
export type ModelMarketplaceFilterControlsProps = {
  idPrefix: string;
  category: ModelMarketplaceCategoryFilter;
  provider: ModelMarketplaceProviderFilter;
  availableProviders: readonly ModelMarketplaceIconKey[];
  onCategoryChange: (value: ModelMarketplaceCategoryFilter) => void;
  onProviderChange: (value: ModelMarketplaceProviderFilter) => void;
};

/**
 * 返回品牌键的人类可读名称。
 *
 * @param provider - 公开 DTO 中经过 schema 收窄的品牌键。
 * @param genericLabel - 当前语言下的通用厂商名称。
 * @returns 固定品牌名或本地化的其他厂商名称。
 * @sideEffects 无。
 */
function getProviderLabel(
  provider: ModelMarketplaceIconKey,
  genericLabel: string
): string {
  const labels: Record<ModelMarketplaceIconKey, string> = {
    openai: "OpenAI",
    google: "Google",
    bytedance: "ByteDance",
    kling: "Kling",
    runway: "Runway",
    xai: "xAI",
    generic: genericLabel,
  };
  return labels[provider];
}

/**
 * 渲染类别与厂商两组键盘可访问的单选筛选。
 *
 * @param props - 当前筛选、真实可用厂商以及两组变更回调。
 * @returns 桌面侧栏和移动 Sheet 可复用的 RadioGroup 组合。
 * @sideEffects 用户选择时调用对应父组件回调。
 * @failure 未知 RadioGroup 值会安全回退到 all。
 */
export function ModelMarketplaceFilterControls({
  idPrefix,
  category,
  provider,
  availableProviders,
  onCategoryChange,
  onProviderChange,
}: ModelMarketplaceFilterControlsProps) {
  const t = useTranslations("ModelMarketplace");
  const categoryOptions = [
    { value: "all" as const, label: t("filters.all") },
    { value: "image" as const, label: t("categories.image") },
    { value: "video" as const, label: t("categories.video") },
  ];

  return (
    <div className="space-y-5">
      <div>
        <p
          className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground"
          id={`${idPrefix}-model-category-label`}
        >
          {t("filters.type")}
        </p>
        <RadioGroup
          aria-labelledby={`${idPrefix}-model-category-label`}
          className="mt-3 gap-1.5"
          onValueChange={(value) =>
            onCategoryChange(parseModelMarketplaceCategoryFilter(value))
          }
          value={category}
        >
          {categoryOptions.map((option) => (
            <Label
              className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-normal transition-colors hover:bg-accent has-[[data-state=checked]]:bg-accent has-[[data-state=checked]]:font-medium"
              htmlFor={`${idPrefix}-model-category-${option.value}`}
              key={option.value}
            >
              <RadioGroupItem
                id={`${idPrefix}-model-category-${option.value}`}
                value={option.value}
              />
              {option.label}
            </Label>
          ))}
        </RadioGroup>
      </div>

      <div className="border-t pt-5">
        <p
          className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground"
          id={`${idPrefix}-model-provider-label`}
        >
          {t("filters.provider")}
        </p>
        <RadioGroup
          aria-labelledby={`${idPrefix}-model-provider-label`}
          className="mt-3 gap-1.5"
          onValueChange={(value) =>
            onProviderChange(parseModelMarketplaceProviderFilter(value))
          }
          value={provider}
        >
          <Label
            className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-normal transition-colors hover:bg-accent has-[[data-state=checked]]:bg-accent has-[[data-state=checked]]:font-medium"
            htmlFor={`${idPrefix}-model-provider-all`}
          >
            <RadioGroupItem id={`${idPrefix}-model-provider-all`} value="all" />
            {t("filters.allProviders")}
          </Label>
          {availableProviders.map((option) => (
            <Label
              className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-normal transition-colors hover:bg-accent has-[[data-state=checked]]:bg-accent has-[[data-state=checked]]:font-medium"
              htmlFor={`${idPrefix}-model-provider-${option}`}
              key={option}
            >
              <RadioGroupItem
                id={`${idPrefix}-model-provider-${option}`}
                value={option}
              />
              <ModelBrandIcon iconKey={option} size={16} />
              {getProviderLabel(option, t("filters.otherProvider"))}
            </Label>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}
