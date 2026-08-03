"use client";

/**
 * 统一号池成员的模型能力多选下拉。
 *
 * 使用方是成员新增/编辑弹窗。本组件只管理搜索、全选和勾选交互，模型来源、成员类型
 * 过滤及历史能力兼容由父组件完成；不会自行构造或接受任意模型 ID。
 */
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Checkbox } from "@repo/ui/components/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/ui/components/popover";
import { ChevronsUpDown, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { BackendMemberModelOption } from "./member-model-options";

/** 模型选项读取状态；degraded 表示模型配置可用但运行时目录暂时不可用。 */
export type BackendMemberModelOptionStatus =
  | "loading"
  | "ready"
  | "degraded"
  | "unavailable";

/** 大小写无关规范化模型 ID，仅用于表单集合比较。 */
function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * 渲染可搜索、可全选的模型能力多选下拉。
 *
 * @param props.options - 已按成员类型过滤并追加历史已选项的候选。
 * @param props.value - 当前明确选择的模型 ID。
 * @param props.onChange - 选择变化回调；输出只由 options 中的 ID 组成。
 * @param props.status - 模型配置读取状态，用于稳定展示降级和失败原因。
 * @param props.disabled - 保存期间禁止修改。
 * @returns 模型选择器、已选摘要与目录状态提示。
 * @sideEffects 仅更新本地弹层和搜索状态并调用 onChange，不发起请求。
 * @failure 空目录或读取失败时显示明确说明，不提供自由文本回退。
 */
export function BackendMemberModelSelect({
  options,
  value,
  onChange,
  status,
  disabled = false,
}: {
  options: readonly BackendMemberModelOption[];
  value: readonly string[];
  onChange: (modelIds: string[]) => void;
  status: BackendMemberModelOptionStatus;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selectedIds = useMemo(
    () => new Set(value.map(normalizeModelId)),
    [value]
  );
  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) =>
      [option.id, option.label, option.category]
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [options, search]);
  const allSelected =
    options.length > 0 &&
    options.every((option) => selectedIds.has(normalizeModelId(option.id)));

  /** 切换单个目录模型，保持其他选择的原始顺序。 */
  function toggleModel(option: BackendMemberModelOption): void {
    const normalizedId = normalizeModelId(option.id);
    if (selectedIds.has(normalizedId)) {
      onChange(
        value.filter((modelId) => normalizeModelId(modelId) !== normalizedId)
      );
      return;
    }
    onChange([...value, option.id]);
  }

  /** 选择当前成员形态允许的全部模型，或在已全选时清空。 */
  function toggleAllModels(): void {
    onChange(allSelected ? [] : options.map((option) => option.id));
  }

  return (
    <div className="space-y-2">
      <Popover
        modal
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            id="member-models"
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            aria-expanded={open}
            disabled={disabled || status === "loading"}
          >
            <span className="truncate">
              {status === "loading"
                ? "正在加载模型配置…"
                : value.length > 0
                  ? `已选择 ${value.length} 个模型`
                  : "请选择支持的模型"}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0"
        >
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder="搜索模型名称或 ID"
              aria-label="搜索模型"
            />
            {search ? (
              <button
                type="button"
                className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="清空模型搜索"
                onClick={() => setSearch("")}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs text-muted-foreground">
              共 {options.length} 个可选模型
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={options.length === 0}
              onClick={toggleAllModels}
            >
              {allSelected ? "清空" : "全选"}
            </Button>
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {filteredOptions.map((option, index) => {
              const selected = selectedIds.has(normalizeModelId(option.id));
              const checkboxId = `member-model-option-${index}`;
              return (
                <label
                  key={`${option.source}:${option.id}`}
                  htmlFor={checkboxId}
                  className="flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-left hover:bg-muted focus-within:ring-2 focus-within:ring-ring"
                >
                  <Checkbox
                    id={checkboxId}
                    checked={selected}
                    className="mt-0.5"
                    onCheckedChange={() => toggleModel(option)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span>{option.label}</span>
                      <Badge
                        variant="outline"
                        className="px-1.5 py-0 text-[10px]"
                      >
                        {option.category === "image" ? "图片" : "视频"}
                      </Badge>
                      {option.source === "existing_member" ? (
                        <Badge
                          variant="secondary"
                          className="px-1.5 py-0 text-[10px]"
                        >
                          历史配置
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {option.id}
                    </span>
                    {option.supportedResolutions?.length ? (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        分辨率：{option.supportedResolutions.join("、")}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                {options.length === 0
                  ? "模型配置中暂无可选模型"
                  : "没有匹配的模型"}
              </div>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {status === "degraded" ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          运行时目录暂不可用，当前仍可选择模型配置中已知的模型。
        </p>
      ) : null}
      {status === "unavailable" ? (
        <p className="text-xs text-destructive">
          模型配置暂不可用，只能保留该成员已有的历史模型。
        </p>
      ) : null}

      {value.length > 0 ? (
        <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto rounded-md border border-dashed p-2">
          {value.map((modelId) => (
            <Badge key={normalizeModelId(modelId)} variant="secondary">
              {modelId}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
