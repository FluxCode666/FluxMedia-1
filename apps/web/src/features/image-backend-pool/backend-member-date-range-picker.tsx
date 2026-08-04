/**
 * 供应商账号创建日期的 shadcn/ui 范围选择器。
 *
 * 使用方：BackendMemberFilterBar。组件把 Calendar 选择结果转换为视图模型使用的
 * YYYY-MM-DD 字符串，只更新父组件筛选草稿，不读取账号数据或触发服务端请求。
 */
"use client";

import { Button } from "@repo/ui/components/button";
import {
  Calendar,
  calendarZhCN,
} from "@repo/ui/components/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/ui/components/popover";
import { cn } from "@repo/ui/utils";
import { format } from "date-fns";
import { CalendarRange, X } from "lucide-react";
import { useState } from "react";

type BackendMemberDateRangePickerProps = {
  createdFrom: string;
  createdTo: string;
  invalid: boolean;
  onRangeChange: (range: {
    createdFrom: string;
    createdTo: string;
  }) => void;
};

type CalendarRangeValue = {
  from?: Date;
  to?: Date;
};

/** 将可信的 YYYY-MM-DD 转为本地日历日期，避免 UTC 解析造成日期偏移。 */
function parseCalendarDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year ?? 0, (month ?? 0) - 1, day ?? 0);

  return date.getFullYear() === year &&
    date.getMonth() === (month ?? 0) - 1 &&
    date.getDate() === day
    ? date
    : undefined;
}

/** 将本地日历日期转换为账号筛选契约使用的 YYYY-MM-DD。 */
function formatCalendarDate(date: Date | undefined): string {
  return date ? format(date, "yyyy-MM-dd") : "";
}

/**
 * 选择或清除供应商账号的创建日期范围。
 *
 * @param props 当前受控范围、合法性与范围变化回调。
 * @returns 使用 shadcn/ui Calendar 范围模式的可访问筛选器。
 * @sideEffects 打开弹层时管理本地显隐状态；选择日期时通知父组件更新筛选。
 */
export function BackendMemberDateRangePicker({
  createdFrom,
  createdTo,
  invalid,
  onRangeChange,
}: BackendMemberDateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const from = parseCalendarDate(createdFrom);
  const to = parseCalendarDate(createdTo);
  const selectedRange = from ? { from, to } : undefined;
  const displayLabel = from
    ? to
      ? `${format(from, "PPP", { locale: calendarZhCN })} – ${format(to, "PPP", { locale: calendarZhCN })}`
      : `${format(from, "PPP", { locale: calendarZhCN })}起`
    : to
      ? `截至${format(to, "PPP", { locale: calendarZhCN })}`
      : "全部创建日期";

  /** 把日历范围立即同步为受控筛选值，单击首日时保留开放区间。 */
  function handleRangeSelect(range: CalendarRangeValue | undefined): void {
    onRangeChange({
      createdFrom: formatCalendarDate(range?.from),
      createdTo: formatCalendarDate(range?.to),
    });
  }

  /** 清除日期范围但保留名称、凭据和模型筛选。 */
  function clearRange(): void {
    onRangeChange({ createdFrom: "", createdTo: "" });
  }

  return (
    <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
      <span id="backend-member-created-range-label">创建日期</span>
      <Popover onOpenChange={setIsOpen} open={isOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={isOpen}
            aria-invalid={invalid}
            aria-labelledby="backend-member-created-range-label"
            className={cn(
              "min-w-0 justify-start gap-2 px-3 font-normal text-foreground",
              invalid && "border-destructive ring-destructive/20"
            )}
            type="button"
            variant="outline"
          >
            <CalendarRange className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">
              {displayLabel}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-auto max-w-[calc(100vw-2rem)] overflow-hidden p-0"
          collisionPadding={16}
          sideOffset={8}
        >
          <div className="border-b px-4 py-3">
            <p className="text-sm font-medium">选择创建日期范围</p>
            <p className="mt-1 text-xs text-muted-foreground">
              先选择起始日期，再选择结束日期。
            </p>
          </div>
          <Calendar
            autoFocus
            className="mx-auto"
            defaultMonth={from ?? to}
            fixedWeeks
            locale={calendarZhCN}
            mode="range"
            onSelect={handleRangeSelect}
            selected={selectedRange}
            showOutsideDays={false}
          />
          <div className="border-t p-2">
            <Button
              className="w-full"
              disabled={!createdFrom && !createdTo}
              onClick={clearRange}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X />
              清除日期
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
