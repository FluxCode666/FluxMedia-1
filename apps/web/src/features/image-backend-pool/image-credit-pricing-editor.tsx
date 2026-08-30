"use client";

/**
 * 图像模型 1024、1K、2K、4K 固定价格编辑器。
 *
 * 使用方：生图后端池的全局模型价格卡与分组覆盖表单。空输入代表继承调用方提供的
 * 回退价格，组件不自行持久化或执行扣费。
 */
import { formatModelIdForDisplay } from "@repo/shared/image-backend/model-display";
import {
  IMAGE_CREDIT_PRICE_FIELDS,
  type ImageCreditOverrides,
  type ImageCreditPriceField,
  normalizeImagePricingModelId,
  type ResolvedImageCreditPricing,
} from "@repo/shared/image-backend/group-image-pricing";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";

export type ImageCreditPricingDraft = Record<
  string,
  Partial<Record<ImageCreditPriceField, string>>
>;

const FIELD_LABELS: Record<ImageCreditPriceField, string> = {
  base1024Credits: "1024×1024",
  base1kCredits: "1K",
  base2kCredits: "2K",
  base4kCredits: "4K",
};

/** 将持久化的稀疏价格转换为保留输入文本的表单草稿。 */
export function imageCreditOverridesToDraft(
  overrides: ImageCreditOverrides
): ImageCreditPricingDraft {
  const draft: ImageCreditPricingDraft = {};
  for (const [model, pricing] of Object.entries(overrides.byModel)) {
    draft[model] = Object.fromEntries(
      IMAGE_CREDIT_PRICE_FIELDS.flatMap((field) => {
        const value = pricing[field];
        return typeof value === "number" ? [[field, String(value)]] : [];
      })
    );
  }
  return draft;
}

/** 将表单草稿收窄为正数稀疏覆盖；空白或非法单元格继续继承。 */
export function imageCreditPricingDraftToOverrides(
  draft: ImageCreditPricingDraft
): ImageCreditOverrides {
  const byModel: ImageCreditOverrides["byModel"] = {};
  for (const [rawModel, row] of Object.entries(draft)) {
    const model = normalizeImagePricingModelId(rawModel);
    if (!model) continue;

    const pricing: ImageCreditOverrides["byModel"][string] = {};
    for (const field of IMAGE_CREDIT_PRICE_FIELDS) {
      const rawValue = row[field]?.trim();
      if (!rawValue) continue;
      const value = Number(rawValue);
      if (Number.isFinite(value) && value > 0 && value <= 100_000) {
        pricing[field] = value;
      }
    }
    if (IMAGE_CREDIT_PRICE_FIELDS.some((field) => pricing[field])) {
      byModel[model] = pricing;
    }
  }
  return { version: 1, byModel };
}

/** 更新单个模型档位输入，保留用户尚未完成的数字文本。 */
export function updateImageCreditPricingDraft(
  draft: ImageCreditPricingDraft,
  model: string,
  field: ImageCreditPriceField,
  value: string
): ImageCreditPricingDraft {
  return {
    ...draft,
    [model]: {
      ...draft[model],
      [field]: value,
    },
  };
}

/** 渲染模型固定价格矩阵，空单元格以继承价格作为 placeholder。 */
export function ImageCreditPricingEditor({
  models,
  draft,
  inheritanceLabel,
  getModelLabel,
  resolveInheritedPricing,
  onChange,
}: {
  models: readonly string[];
  draft: ImageCreditPricingDraft;
  inheritanceLabel: string;
  getModelLabel?: (model: string) => string;
  resolveInheritedPricing: (model: string) => ResolvedImageCreditPricing;
  onChange: (
    model: string,
    field: ImageCreditPriceField,
    value: string
  ) => void;
}) {
  return (
    <div className="space-y-3">
      {models.map((model) => {
        const inherited = resolveInheritedPricing(model);
        return (
          <div key={model} className="space-y-2 rounded-md border p-3">
            <div>
              <p className="truncate text-sm font-medium">
                {formatModelIdForDisplay(getModelLabel?.(model) ?? model)}
              </p>
              <p className="text-xs text-muted-foreground">
                留空时{inheritanceLabel}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {IMAGE_CREDIT_PRICE_FIELDS.map((field) => (
                <div key={field} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {FIELD_LABELS[field]}
                  </Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    max="100000"
                    step="0.01"
                    placeholder={String(inherited[field])}
                    value={draft[model]?.[field] ?? ""}
                    onChange={(event) =>
                      onChange(model, field, event.target.value)
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
