/**
 * 用户端与管理端数据看板的受控 shadcn/ui 日期范围选择器。
 *
 * 使用方：两个数据看板 Panel。触发器只展示已应用范围，弹层维护由父组件持久化的草稿；
 * 选择日期或快捷范围不查询，只有点击应用才提交最多 30 天的完整范围。
 */
"use client";

import {
  DATA_DASHBOARD_MAX_DAYS,
  dataDashboardInputSchema,
} from "@repo/shared/analytics/contracts";
import { Button } from "@repo/ui/components/button";
import {
  Calendar,
  calendarEnUS,
  calendarZhCN,
} from "@repo/ui/components/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/ui/components/popover";
import { cn } from "@repo/ui/utils";
import { differenceInCalendarDays, format } from "date-fns";
import { CalendarRange, Check } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import {
  type DataDashboardAppliedRange,
  buildDataDashboardPresetRange,
} from "./data-dashboard-query";

type DraftRange = { startDate: string; endDate: string };
type DraftValidation =
  | { valid: true; dayCount: number }
  | {
      valid: false;
      reason: "incomplete" | "invalid" | "reversed" | "future" | "too_long";
    };

type CalendarRangeValue = { from?: Date; to?: Date };

type DataDashboardDateRangePickerProps = {
  today: string;
  appliedRange: DataDashboardAppliedRange;
  draftRange: DraftRange;
  disabled?: boolean;
  isApplying?: boolean;
  onDraftChange: (range: DraftRange) => void;
  onApply: (range: DataDashboardAppliedRange) => void;
};

/** 将 YYYY-MM-DD 转为本地日历对象，仅用于控件显示，不参与统计桶边界。 */
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

/** 将本地日历对象转回 URL/UOL 使用的稳定日期字符串。 */
function formatCalendarDate(date: Date | undefined): string {
  return date ? format(date, "yyyy-MM-dd") : "";
}

/** 监听桌面断点，让窄屏保持单月、桌面展示双月。 */
function useDesktopCalendar(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

/**
 * 校验日期草稿能否应用。
 *
 * @param range 尚未信任的两个字符串边界。
 * @param today 当前快照账号时区中的今天。
 * @returns 成功时给出 inclusive 天数；失败时给出可本地化原因。
 */
export function validateDataDashboardDraftRange(
  range: DraftRange,
  today: string
): DraftValidation {
  if (!range.startDate || !range.endDate) {
    return { valid: false, reason: "incomplete" };
  }
  if (!dataDashboardInputSchema.safeParse(range).success) {
    return { valid: false, reason: "invalid" };
  }
  if (range.endDate < range.startDate) {
    return { valid: false, reason: "reversed" };
  }
  if (range.startDate > today || range.endDate > today) {
    return { valid: false, reason: "future" };
  }
  const start = parseCalendarDate(range.startDate);
  const end = parseCalendarDate(range.endDate);
  if (!start || !end) return { valid: false, reason: "invalid" };
  const dayCount = differenceInCalendarDays(end, start) + 1;
  if (dayCount > DATA_DASHBOARD_MAX_DAYS) {
    return { valid: false, reason: "too_long" };
  }
  return { valid: true, dayCount };
}

/**
 * 渲染已应用范围触发器和受控草稿日历。
 *
 * @param props 快照 today、已应用范围、草稿与提交回调。
 * @returns 可键盘操作的响应式范围弹层；不自行发起网络请求。
 */
export function DataDashboardDateRangePicker({
  today,
  appliedRange,
  draftRange,
  disabled = false,
  isApplying = false,
  onDraftChange,
  onApply,
}: DataDashboardDateRangePickerProps) {
  const locale = useLocale();
  const t = useTranslations("DataDashboard");
  const calendarLocale = locale === "zh" ? calendarZhCN : calendarEnUS;
  const isDesktop = useDesktopCalendar();
  const [isOpen, setIsOpen] = useState(false);
  const appliedCalendarRange = useMemo(
    () => ({
      from: parseCalendarDate(appliedRange.startDate),
      to: parseCalendarDate(appliedRange.endDate),
    }),
    [appliedRange.endDate, appliedRange.startDate]
  );
  const draftCalendarRange = useMemo(
    () => ({
      from: parseCalendarDate(draftRange.startDate),
      to: parseCalendarDate(draftRange.endDate),
    }),
    [draftRange.endDate, draftRange.startDate]
  );
  const validation = validateDataDashboardDraftRange(draftRange, today);
  const maxSelectableDate = parseCalendarDate(today);
  const hasUnappliedDraft =
    draftRange.startDate !== appliedRange.startDate ||
    draftRange.endDate !== appliedRange.endDate;
  const displayLabel = appliedCalendarRange.from
    ? appliedCalendarRange.to
      ? `${format(appliedCalendarRange.from, "PP", {
          locale: calendarLocale,
        })} – ${format(appliedCalendarRange.to, "PP", {
          locale: calendarLocale,
        })}`
      : format(appliedCalendarRange.from, "PP", { locale: calendarLocale })
    : t("date.select");

  /** 将 DayPicker 的选择转换为受控字符串草稿，不触发 action。 */
  function handleRangeSelect(range: CalendarRangeValue | undefined): void {
    onDraftChange({
      startDate: formatCalendarDate(range?.from),
      endDate: formatCalendarDate(range?.to),
    });
  }

  /** 将草稿切到账号时区 today 结束的快捷范围。 */
  function selectPreset(days: 7 | 30): void {
    onDraftChange(buildDataDashboardPresetRange(today, days));
  }

  /** 只提交完整合法草稿；失败后的草稿仍由父组件保留。 */
  function applyRange(): void {
    if (!validation.valid || isApplying) return;
    setIsOpen(false);
    onApply({
      startDate: draftRange.startDate,
      endDate: draftRange.endDate,
    });
  }

  const validationMessage = validation.valid
    ? t("date.selectedDays", { days: validation.dayCount })
    : t(`date.error.${validation.reason}`);

  return (
    <Popover onOpenChange={setIsOpen} open={isOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={isOpen}
          className="h-auto min-h-9 w-full justify-start gap-2 px-3 py-2 font-normal sm:w-auto sm:min-w-[280px]"
          disabled={disabled}
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
        align="end"
        className="max-h-[var(--radix-popover-content-available-height)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
        collisionPadding={16}
        sideOffset={8}
      >
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">{t("date.select")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("date.limit", { days: DATA_DASHBOARD_MAX_DAYS })}
          </p>
          <fieldset className="mt-3">
            <legend className="text-xs font-medium text-muted-foreground">
              {t("date.quickRanges")}
            </legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {[7, 30].map((days) => (
                <Button
                  key={days}
                  onClick={() => selectPreset(days as 7 | 30)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {t(`date.lastDays.${days}`)}
                </Button>
              ))}
            </div>
          </fieldset>
          {hasUnappliedDraft ? (
            <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-300">
              {t("date.unapplied")}
            </p>
          ) : null}
        </div>
        <Calendar
          autoFocus
          className="mx-auto"
          defaultMonth={draftCalendarRange.from}
          disabled={
            maxSelectableDate ? { after: maxSelectableDate } : undefined
          }
          excludeDisabled
          fixedWeeks
          locale={calendarLocale}
          mode="range"
          numberOfMonths={isDesktop ? 2 : 1}
          onSelect={handleRangeSelect}
          selected={draftCalendarRange.from ? draftCalendarRange : undefined}
          showOutsideDays={false}
        />
        <div className="sticky bottom-0 border-t bg-popover px-3 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p
              aria-live="polite"
              className={cn(
                "min-h-4 text-xs text-muted-foreground",
                !validation.valid &&
                  validation.reason !== "incomplete" &&
                  "text-destructive"
              )}
            >
              {validationMessage}
            </p>
            <Button
              disabled={!validation.valid || isApplying}
              onClick={applyRange}
              size="sm"
              type="button"
            >
              <Check />
              {t("date.apply")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
