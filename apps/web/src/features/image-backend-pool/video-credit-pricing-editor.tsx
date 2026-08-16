"use client";

/**
 * 后端分组视频模型分辨率双价格覆盖编辑器。
 *
 * 使用方：分组表单。模型、支持分辨率、全局模式和两套继承价都来自模型配置 UOL
 * 快照；组件只编辑按秒与按条金额，绝不提供或提交分组计费模式。
 */
import { getVideoPricingResolutionKey } from "@repo/shared/adobe";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";

/** 分组编辑器消费的单个视频模型全局价格事实。 */
export type VideoCreditPricingModel = {
  modelId: string;
  displayName: string;
  billingMode: "per_second" | "per_item";
  supportedResolutions: readonly string[];
  globalCreditsPerSecondByResolution: Readonly<Record<string, number>>;
  globalCreditsPerItemByResolution: Readonly<Record<string, number>>;
};

/** 分组两套稀疏覆盖的本地字符串草稿。 */
export type VideoCreditPricingDraft = {
  perSecond: Record<string, string>;
  perItem: Record<string, string>;
};

type VideoCreditPricingMode = "per_second" | "per_item";

/**
 * 把一套合法数字覆盖转换为可保留输入过程的字符串草稿。
 *
 * @param models - 当前模型配置快照中的视频模型。
 * @param overrides - 已通过分组摘要校验的一套稀疏覆盖。
 * @returns 当前模型级旧值展开后的分辨率草稿，并保留目录外的历史精确键。
 * @sideEffects 无。
 * @failure 不抛错。
 */
function toPricingDraft(
  models: readonly VideoCreditPricingModel[],
  overrides: Record<string, number>
): Record<string, string> {
  const editableKeys = new Set(
    models.flatMap((model) =>
      model.supportedResolutions.map((resolution) =>
        getVideoPricingResolutionKey(model.modelId, resolution)
      )
    )
  );
  const knownModelIds = new Set(models.map((model) => model.modelId));
  const draft = Object.fromEntries(
    Object.entries(overrides).flatMap(([key, value]) => {
      // WHY：已从目录移除的模型或分辨率仍保留，避免管理员编辑其他字段时静默丢价。
      if (editableKeys.has(key) || knownModelIds.has(key)) return [];
      return [[key, String(value)]];
    })
  );

  for (const model of models) {
    const legacyModelPrice = overrides[model.modelId];
    for (const resolution of model.supportedResolutions) {
      const key = getVideoPricingResolutionKey(model.modelId, resolution);
      const value = overrides[key] ?? legacyModelPrice;
      if (typeof value === "number") draft[key] = String(value);
    }
  }
  return draft;
}

/**
 * 从分组双价格覆盖创建编辑草稿。
 *
 * @param models - 模型配置快照中的视频模型和分辨率。
 * @param perSecondOverrides - 旧字段承载的按秒稀疏覆盖。
 * @param perItemOverrides - 新字段承载的按条稀疏覆盖。
 * @returns 两套互不回退的字符串草稿；已知模型级旧值展开到当前全部分辨率。
 * @sideEffects 无。
 * @failure 不抛错；输入已经过分组摘要 schema 校验。
 */
export function createVideoCreditPricingDraft(
  models: readonly VideoCreditPricingModel[],
  perSecondOverrides: Record<string, number>,
  perItemOverrides: Record<string, number>
): VideoCreditPricingDraft {
  return {
    perSecond: toPricingDraft(models, perSecondOverrides),
    perItem: toPricingDraft(models, perItemOverrides),
  };
}

/**
 * 把一套字符串草稿压缩为稀疏分组覆盖。
 *
 * @param draft - 包含空白或输入中间态的字符串映射。
 * @returns 仅包含合法正有限单价的稀疏映射。
 * @sideEffects 无。
 * @failure 不抛错；服务端 schema 负责最终拒绝伪造输入。
 */
function pricingDraftToOverrides(
  draft: Record<string, string>
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(draft)) {
    const value = Number(rawValue.trim());
    if (
      !key.trim() ||
      !rawValue.trim() ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 100_000
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * 把双价格草稿压缩为可提交的两套稀疏 map。
 *
 * @param draft - 可包含空单元格和输入中间态的本地草稿。
 * @returns 两套独立的正数覆盖；空白或非法值不进入提交结果。
 * @sideEffects 无。
 * @failure 不抛错；服务端 schema 仍会最终校验提交内容。
 */
export function videoCreditPricingDraftToOverrides(
  draft: VideoCreditPricingDraft
): { perSecond: Record<string, number>; perItem: Record<string, number> } {
  return {
    perSecond: pricingDraftToOverrides(draft.perSecond),
    perItem: pricingDraftToOverrides(draft.perItem),
  };
}

/**
 * 更新单个模型分辨率的一种计费金额。
 *
 * @param draft - 当前双价格草稿。
 * @param mode - 要修改的按秒或按条价格表。
 * @param modelId - 公开模型 ID。
 * @param resolution - 模型支持的输出分辨率。
 * @param value - 输入框原始字符串；空字符串表示继承全局价格。
 * @returns 只复制被修改价格表的新草稿。
 * @sideEffects 无。
 * @failure 不抛错；服务端会拒绝伪造或越界键值。
 */
export function updateVideoCreditPricingDraft(
  draft: VideoCreditPricingDraft,
  mode: VideoCreditPricingMode,
  modelId: string,
  resolution: string,
  value: string
): VideoCreditPricingDraft {
  const key = getVideoPricingResolutionKey(modelId, resolution);
  if (mode === "per_second") {
    return { ...draft, perSecond: { ...draft.perSecond, [key]: value } };
  }
  return { ...draft, perItem: { ...draft.perItem, [key]: value } };
}

/**
 * 渲染分组视频双价格矩阵。
 *
 * @param props.models - 模型配置 UOL 返回的视频模型全局事实。
 * @param props.draft - 当前分组的两套稀疏草稿。
 * @param props.onChange - 单个分辨率金额变化回调，不接收模式修改。
 * @returns 每个模型全部分辨率的按秒和按条输入；空白时以全局价格作占位提示。
 * @sideEffects 仅通过 onChange 报告用户输入。
 * @failure 模型列表为空时显示稳定说明，不渲染输入。
 */
export function VideoCreditPricingEditor({
  models,
  draft,
  onChange,
}: {
  models: readonly VideoCreditPricingModel[];
  draft: VideoCreditPricingDraft;
  onChange: (
    mode: VideoCreditPricingMode,
    modelId: string,
    resolution: string,
    value: string
  ) => void;
}) {
  if (models.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        模型配置中暂无可编辑的视频模型。
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {models.map((model) => (
        <section
          className="overflow-x-auto rounded-md border"
          key={model.modelId}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <div>
              <h4 className="text-sm font-medium">{model.displayName}</h4>
              <p className="text-xs text-muted-foreground">{model.modelId}</p>
            </div>
            <span className="rounded-full border px-2 py-1 text-xs text-muted-foreground">
              当前全局模式：
              {model.billingMode === "per_second" ? "按秒" : "按条"}
            </span>
          </div>
          <div className="grid min-w-[376px] grid-cols-[minmax(72px,0.7fr)_minmax(140px,1fr)_minmax(140px,1fr)] gap-x-3 gap-y-2 p-3">
            <span className="text-xs font-medium text-muted-foreground">
              分辨率
            </span>
            <span className="text-xs font-medium text-muted-foreground">
              按秒覆盖（积分/秒）
            </span>
            <span className="text-xs font-medium text-muted-foreground">
              按条覆盖（积分/条）
            </span>
            {model.supportedResolutions.map((resolution) => {
              const key = getVideoPricingResolutionKey(
                model.modelId,
                resolution
              );
              const globalPerSecond =
                model.globalCreditsPerSecondByResolution[resolution];
              const globalPerItem =
                model.globalCreditsPerItemByResolution[resolution];
              return (
                <div className="contents" key={key}>
                  <Label className="self-center text-sm font-normal">
                    {resolution}
                  </Label>
                  <Input
                    aria-label={`${model.displayName} ${resolution} 按秒积分覆盖`}
                    inputMode="decimal"
                    max="100000"
                    min="0.01"
                    onChange={(event) =>
                      onChange(
                        "per_second",
                        model.modelId,
                        resolution,
                        event.target.value
                      )
                    }
                    placeholder={
                      typeof globalPerSecond === "number"
                        ? String(globalPerSecond)
                        : ""
                    }
                    step="0.01"
                    title="留空继承全局按秒价格"
                    type="number"
                    value={draft.perSecond[key] ?? ""}
                  />
                  <Input
                    aria-label={`${model.displayName} ${resolution} 按条积分覆盖`}
                    inputMode="decimal"
                    max="100000"
                    min="0.01"
                    onChange={(event) =>
                      onChange(
                        "per_item",
                        model.modelId,
                        resolution,
                        event.target.value
                      )
                    }
                    placeholder={
                      typeof globalPerItem === "number"
                        ? String(globalPerItem)
                        : ""
                    }
                    step="0.01"
                    title="留空继承全局按条价格"
                    type="number"
                    value={draft.perItem[key] ?? ""}
                  />
                </div>
              );
            })}
          </div>
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            清空任一金额后，该分辨率继承对应的全局价格。
          </p>
        </section>
      ))}
    </div>
  );
}
