"use client";

/**
 * 通用分页大小选择器。
 *
 * 使用方：所有带分页的列表。基于 shadcn/ui Select 呈现可访问的白名单选项，
 * 业务层负责在值变化后重置页码或 cursor。
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

export type PageSizeSelectProps = {
  value: number;
  options: readonly number[];
  label: string;
  itemSuffix?: string;
  disabled?: boolean;
  className?: string;
  onValueChange: (pageSize: number) => void;
};

/**
 * 渲染受控的每页记录数选择器。
 *
 * @param props - 当前值、白名单、可访问标签与变更回调。
 * @returns shadcn Select；仅可能回调白名单内的整数值。
 */
export function PageSizeSelect({
  value,
  options,
  label,
  itemSuffix = "",
  disabled = false,
  className,
  onValueChange,
}: PageSizeSelectProps) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(nextValue) => {
        const nextSize = Number(nextValue);
        if (options.includes(nextSize)) onValueChange(nextSize);
      }}
      value={String(value)}
    >
      <SelectTrigger aria-label={label} className={className ?? "w-28"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((size) => (
          <SelectItem key={size} value={String(size)}>
            {size}
            {itemSuffix}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
