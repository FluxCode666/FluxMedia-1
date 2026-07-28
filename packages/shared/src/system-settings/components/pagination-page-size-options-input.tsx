"use client";

import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Plus, Trash2 } from "lucide-react";
/**
 * 系统设置中的分页大小白名单编辑器。
 *
 * 使用方：SystemSettingsPanel。将 JSON 草稿呈现为结构化数字输入，固定保留默认
 * 分页大小 20；最终保存仍由系统设置服务端 schema 做权威校验。
 */
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGE_SIZE_OPTIONS,
  MAX_PAGE_SIZE,
  paginationPageSizeOptionsSchema,
} from "../../pagination/config";

type PaginationPageSizeOptionsInputProps = {
  value: unknown;
  disabled: boolean;
  onChange: (value: string) => void;
};

/** 将面板 JSON 草稿安全解析为可编辑数组，损坏草稿回退默认值。 */
function parseDraftOptions(value: unknown): number[] {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      return [...DEFAULT_PAGE_SIZE_OPTIONS];
    }
  }
  const parsed = paginationPageSizeOptionsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : [...DEFAULT_PAGE_SIZE_OPTIONS];
}

/** 选择一个未使用且位于约束范围内的新分页大小。 */
function getNextOption(options: readonly number[]): number | null {
  for (const candidate of [10, 50, 100]) {
    if (!options.includes(candidate)) return candidate;
  }
  for (let candidate = 1; candidate <= MAX_PAGE_SIZE; candidate += 1) {
    if (!options.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * 渲染分页大小数字列表及增删操作。
 *
 * @param props - JSON 草稿、禁用状态和字符串草稿回调。
 * @returns 结构化编辑器；20 始终锁定且不可删除。
 */
export function PaginationPageSizeOptionsInput({
  value,
  disabled,
  onChange,
}: PaginationPageSizeOptionsInputProps) {
  const options = parseDraftOptions(value);

  /** 将排序后的白名单序列化回系统设置 JSON 草稿。 */
  function updateOptions(nextOptions: number[]): void {
    onChange(
      JSON.stringify([...nextOptions].sort((left, right) => left - right))
    );
  }

  const nextOption = getNextOption(options);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((size) => (
          <div className="flex items-center gap-2" key={size}>
            <Input
              aria-label={`每页 ${size} 条`}
              disabled={disabled || size === DEFAULT_PAGE_SIZE}
              max={MAX_PAGE_SIZE}
              min={1}
              onChange={(event) => {
                const nextSize = Number(event.target.value);
                if (
                  !Number.isInteger(nextSize) ||
                  nextSize < 1 ||
                  nextSize > MAX_PAGE_SIZE ||
                  options.includes(nextSize)
                ) {
                  return;
                }
                updateOptions(
                  options.map((option) => (option === size ? nextSize : option))
                );
              }}
              type="number"
              value={size}
            />
            <Button
              aria-label={`删除每页 ${size} 条`}
              disabled={disabled || size === DEFAULT_PAGE_SIZE}
              onClick={() =>
                updateOptions(options.filter((option) => option !== size))
              }
              size="icon"
              type="button"
              variant="outline"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        disabled={disabled || options.length >= 10 || nextOption === null}
        onClick={() => {
          if (nextOption !== null) updateOptions([...options, nextOption]);
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus />
        添加选项
      </Button>
      <p className="text-xs text-muted-foreground">
        默认每页 20 条且不可移除；最多配置 10 个不重复选项，单项范围为 1 至
        100。
      </p>
    </div>
  );
}
