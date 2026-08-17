"use client";

/**
 * 模型配置管理列表。
 *
 * 使用方是 ModelConfigurationPanel；桌面使用紧凑语义表格，窄屏保持列语义并允许横向滚动。
 * 本组件只展示共享 DTO、复制完整 ID 并通知父层打开 Dialog，不读取或保存配置。
 */
import type { ModelConfigurationEntry } from "@repo/shared/model-marketplace";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Copy, ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ModelBrandIcon } from "@/features/model-marketplace/model-brand-icon";

import {
  formatModelConfigurationMinimumCredits,
  getModelConfigurationCategoryLabel,
  getModelConfigurationCoverSource,
  getModelConfigurationEnabledLabel,
  getModelConfigurationHomepageLabel,
  getModelConfigurationPriceUnitLabel,
  getModelConfigurationVisibilityLabel,
  resolveModelConfigurationCoverAfterError,
} from "./model-configuration-view-model";

export type ModelConfigurationTableProps = {
  entries: readonly ModelConfigurationEntry[];
  canEdit: boolean;
  onSelect: (entry: ModelConfigurationEntry) => void;
};

/**
 * 渲染固定 3:2 缩略图，并在自定义图失败时只回退一次本地默认图。
 *
 * @param entry - 当前管理条目。
 * @returns 模型图片或占位；两种形态尺寸完全一致。
 * @sideEffects 浏览器读取第一方图片；解码失败只更新本地 src。
 * @failure 默认封面也失败时停止渲染 img，避免无限 onError。
 */
function ModelCoverThumbnail({ entry }: { entry: ModelConfigurationEntry }) {
  const initialSource = getModelConfigurationCoverSource(entry);
  const [source, setSource] = useState<string | null>(initialSource);

  useEffect(() => {
    setSource(initialSource);
  }, [initialSource]);

  /** 执行一次类别默认封面回退。 */
  const handleError = (): void => {
    if (!source) return;
    setSource(resolveModelConfigurationCoverAfterError(source, entry.category));
  };

  return (
    <div className="aspect-[3/2] w-24 overflow-hidden rounded-md border bg-muted/40">
      {source ? (
        // biome-ignore lint/performance/noImgElement: 运行时封面需要原生 onError 单次回退。
        <img
          src={source}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover"
          onError={handleError}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <ImageIcon className="h-4 w-4" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

/**
 * 渲染品牌图标、完整模型 ID 的省略视图及紧随其后的复制图标。
 *
 * @param entry - 当前管理条目。
 * @returns 可收缩但可通过 title 查看完整 ID 的单行身份块。
 * @sideEffects 点击复制按钮写入剪贴板并显示反馈。
 * @failure Clipboard 被拒绝时提示手动复制，不改变列表状态。
 */
function ModelIdentity({ entry }: { entry: ModelConfigurationEntry }) {
  /** 复制服务端交付的完整 configKey。 */
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.configKey);
      toast.success("模型 ID 已复制");
    } catch {
      toast.error("复制失败，请手动选择模型 ID");
    }
  };

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <ModelBrandIcon iconKey={entry.iconKey} size={18} />
        <code
          className="truncate text-xs font-medium text-foreground"
          title={entry.configKey}
        >
          {entry.configKey}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`复制模型 ID ${entry.configKey}`}
          title="复制模型 ID"
          onClick={handleCopy}
        >
          <Copy />
        </Button>
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {entry.displayName}
      </p>
    </div>
  );
}

/**
 * 渲染模型广场状态 Badge。
 *
 * @param entry - 当前条目。
 * @returns 已展示使用 secondary，其他状态使用 outline。
 * @sideEffects 无。
 */
function VisibilityBadge({ entry }: { entry: ModelConfigurationEntry }) {
  const label = getModelConfigurationVisibilityLabel(entry);
  return (
    <Badge variant={label === "已展示" ? "secondary" : "outline"}>
      {label}
    </Badge>
  );
}

/**
 * 渲染模型是否允许进入目录与生成调用。
 *
 * @param entry - 当前管理条目。
 * @returns 启用状态 Badge；停用使用 destructive 强调影响范围。
 * @sideEffects 无。
 * @failure 共享 DTO 已校验 enabled，不抛错。
 */
function EnabledBadge({ entry }: { entry: ModelConfigurationEntry }) {
  return (
    <Badge variant={entry.enabled ? "secondary" : "destructive"}>
      {getModelConfigurationEnabledLabel(entry)}
    </Badge>
  );
}

/**
 * 渲染官网首页展示状态及其数值优先级。
 *
 * @param entry - 当前管理条目。
 * @returns 开启时使用强调 Badge，关闭时使用轮廓 Badge。
 * @sideEffects 无。
 */
function HomepageBadge({ entry }: { entry: ModelConfigurationEntry }) {
  return (
    <Badge variant={entry.homepageVisible ? "secondary" : "outline"}>
      {getModelConfigurationHomepageLabel(entry)}
    </Badge>
  );
}

/**
 * 渲染模型配置响应式列表。
 *
 * @param props - 已筛选条目、服务端编辑权限和行选择回调。
 * @returns 空态或带表头且窄屏可横向滚动的列表。
 * @sideEffects 行操作调用 onSelect；复制操作由身份子组件处理。
 * @failure 空数组稳定展示无结果，不伪造模型。
 */
export function ModelConfigurationTable({
  entries,
  canEdit,
  onSelect,
}: ModelConfigurationTableProps) {
  if (entries.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center border-t text-sm text-muted-foreground">
        没有符合条件的模型
      </div>
    );
  }

  return (
    <div
      id="model-configuration-list"
      className="overflow-x-auto border-t"
      tabIndex={-1}
    >
      <table className="w-full min-w-[980px] table-fixed text-sm">
        <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="w-32 px-4 py-3 font-medium">
              封面
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              模型
            </th>
            <th scope="col" className="w-28 px-4 py-3 font-medium">
              类型
            </th>
            <th scope="col" className="w-24 px-4 py-3 font-medium">
              状态
            </th>
            <th scope="col" className="w-28 px-4 py-3 font-medium">
              模型广场
            </th>
            <th scope="col" className="w-32 px-4 py-3 font-medium">
              官网首页
            </th>
            <th scope="col" className="w-32 px-4 py-3 font-medium">
              最低价格
            </th>
            <th scope="col" className="w-24 px-4 py-3 text-right font-medium">
              操作
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {entries.map((entry) => (
            <tr
              key={`${entry.category}:${entry.configKey}`}
              className="transition-colors hover:bg-muted/20"
            >
              <td className="px-4 py-3">
                <ModelCoverThumbnail entry={entry} />
              </td>
              <td className="px-4 py-3">
                <ModelIdentity entry={entry} />
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                <span className="block">
                  {getModelConfigurationCategoryLabel(entry)}
                </span>
                {entry.supportedResolutions?.length ? (
                  <span className="mt-1 block text-[11px]">
                    {entry.supportedResolutions.join("、")}
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3">
                <EnabledBadge entry={entry} />
              </td>
              <td className="px-4 py-3">
                <VisibilityBadge entry={entry} />
              </td>
              <td className="px-4 py-3">
                <HomepageBadge entry={entry} />
              </td>
              <td className="px-4 py-3 tabular-nums">
                {entry.category === "image" &&
                entry.pricingSource === "unconfigured"
                  ? "未配置"
                  : formatModelConfigurationMinimumCredits(
                      entry.minimumCredits
                    )}
                {getModelConfigurationPriceUnitLabel(entry) ? (
                  <span className="text-muted-foreground">
                    {getModelConfigurationPriceUnitLabel(entry)}
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3 text-right">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onSelect(entry)}
                >
                  {canEdit ? "编辑" : "查看"}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
