"use client";

/**
 * 后端分组视频模型族每秒积分覆盖编辑器。
 *
 * 使用方：后端分组价格覆盖表。组件保留旧版 family 级稀疏覆盖；全局模型配置改由模型
 * 配置弹窗按分辨率编辑，运行时仍允许 metadata 直接提供 family@resolution 精确覆盖。
 */
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";

export type VideoCreditPricingDraft = Record<string, string>;

/** 将 family → 数字价格转换为可保留输入过程的字符串草稿。 */
export function videoCreditOverridesToDraft(
  families: readonly string[],
  overrides: Record<string, number>
): VideoCreditPricingDraft {
  return Object.fromEntries(
    families.map((family) => {
      const value = overrides[family];
      return [
        family,
        typeof value === "number" && Number.isFinite(value) && value > 0
          ? String(value)
          : "",
      ];
    })
  );
}

/** 把合法正数草稿压缩为稀疏分组覆盖或完整全局价格的通用 map。 */
export function videoCreditPricingDraftToOverrides(
  draft: VideoCreditPricingDraft
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [family, rawValue] of Object.entries(draft)) {
    const value = Number(rawValue.trim());
    if (
      !family.trim() ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 100_000
    ) {
      continue;
    }
    result[family] = value;
  }
  return result;
}

/** 更新单个模型族的本地输入值，不丢失其他尚未保存的价格。 */
export function updateVideoCreditPricingDraft(
  draft: VideoCreditPricingDraft,
  family: string,
  value: string
): VideoCreditPricingDraft {
  return { ...draft, [family]: value };
}

/** 渲染视频模型族每秒积分输入表，空单元格显示调用方提供的继承价格。 */
export function VideoCreditPricingEditor({
  families,
  draft,
  inheritanceLabel,
  resolveInheritedPrice,
  onChange,
}: {
  families: readonly string[];
  draft: VideoCreditPricingDraft;
  inheritanceLabel: string;
  resolveInheritedPrice: (family: string) => number;
  onChange: (family: string, value: string) => void;
}) {
  return (
    <div className="space-y-2">
      {families.map((family) => (
        <div
          key={family}
          className="grid grid-cols-[minmax(0,1fr)_140px] items-center gap-3"
        >
          <div className="min-w-0">
            <Label className="truncate text-sm font-normal">{family}</Label>
            <p className="text-xs text-muted-foreground">
              留空时{inheritanceLabel}
            </p>
          </div>
          <Input
            type="number"
            inputMode="decimal"
            min="0.01"
            max="100000"
            step="0.01"
            placeholder={String(resolveInheritedPrice(family))}
            value={draft[family] ?? ""}
            onChange={(event) => onChange(family, event.target.value)}
          />
        </div>
      ))}
    </div>
  );
}
