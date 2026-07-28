"use client";

/**
 * 订单管理受控日期范围选择器。
 *
 * 使用方：PaymentOrderFilters。使用 shadcn/ui Calendar 与 Popover 编辑创建日期范围，
 * 只更新父筛选器草稿；真正查询仍由筛选表单统一提交并清除 cursor。
 */
import { ADMIN_PAYMENT_OVERVIEW_MAX_DAYS } from "@repo/shared/payment/admin-contract";
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

type PaymentOrderDateRangePickerProps = {
  disabled: boolean;
  endDate: string;
  onRangeChange: (range: { startDate: string; endDate: string }) => void;
  startDate: string;
  today: string;
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

/** 将本地日历日期转为 URL 与 UOL 契约使用的 YYYY-MM-DD。 */
function formatCalendarDate(date: Date | undefined): string {
  return date ? format(date, "yyyy-MM-dd") : "";
}

/** 监听桌面断点，让移动端展示单月、桌面端展示双月。 */
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
 * 渲染订单创建日期范围草稿并在确认后回传父筛选器。
 *
 * @param props 已应用草稿、部署时区今天、禁用状态与范围回调。
 * @returns 响应式 shadcn/ui 日期范围选择器。
 * @sideEffects 仅更新本地与父组件 React 状态，不主动导航或查询。
 */
export function PaymentOrderDateRangePicker({
  disabled,
  endDate,
  onRangeChange,
  startDate,
  today,
}: PaymentOrderDateRangePickerProps) {
  const locale = useLocale();
  const t = useTranslations("AdminPayments.orders");
  const isDesktop = useDesktopCalendar();
  const [isOpen, setIsOpen] = useState(false);
  const [draftStartDate, setDraftStartDate] = useState(startDate);
  const [draftEndDate, setDraftEndDate] = useState(endDate);
  const calendarLocale = locale === "zh" ? calendarZhCN : calendarEnUS;

  useEffect(() => {
    setDraftStartDate(startDate);
    setDraftEndDate(endDate);
  }, [endDate, startDate]);

  const appliedRange = useMemo(
    () => ({
      from: parseCalendarDate(startDate),
      to: parseCalendarDate(endDate),
    }),
    [endDate, startDate]
  );
  const draftRange = useMemo(
    () => ({
      from: parseCalendarDate(draftStartDate),
      to: parseCalendarDate(draftEndDate),
    }),
    [draftEndDate, draftStartDate]
  );
  const todayDate = parseCalendarDate(today);
  const selectedDayCount =
    draftRange.from && draftRange.to
      ? differenceInCalendarDays(draftRange.to, draftRange.from) + 1
      : null;
  const isFutureRange = Boolean(
    (draftStartDate && draftStartDate > today) ||
      (draftEndDate && draftEndDate > today)
  );
  const exceedsLimit = Boolean(
    selectedDayCount && selectedDayCount > ADMIN_PAYMENT_OVERVIEW_MAX_DAYS
  );
  const canConfirm = Boolean(
    draftRange.from &&
      draftRange.to &&
      !isFutureRange &&
      !exceedsLimit &&
      !disabled
  );
  const displayLabel = appliedRange.from
    ? appliedRange.to
      ? `${format(appliedRange.from, "PP", { locale: calendarLocale })} – ${format(appliedRange.to, "PP", { locale: calendarLocale })}`
      : format(appliedRange.from, "PP", { locale: calendarLocale })
    : t("selectDateRange");

  /** 打开时恢复父筛选器值，关闭时丢弃未确认的日历草稿。 */
  function handleOpenChange(nextOpen: boolean): void {
    if (nextOpen) {
      setDraftStartDate(startDate);
      setDraftEndDate(endDate);
    }
    setIsOpen(nextOpen);
  }

  /** 将 DayPicker 的范围草稿转换为稳定日历日期字符串。 */
  function handleRangeSelect(range: CalendarRangeValue | undefined): void {
    setDraftStartDate(formatCalendarDate(range?.from));
    setDraftEndDate(formatCalendarDate(range?.to));
  }

  /** 确认完整合法范围并回传父筛选器，不触发页面导航。 */
  function confirmRange(): void {
    if (!canConfirm) return;
    onRangeChange({
      startDate: draftStartDate,
      endDate: draftEndDate,
    });
    setIsOpen(false);
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={isOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={isOpen}
          aria-label={t("dateRange")}
          className="min-w-0 justify-start gap-2 px-3 font-normal text-foreground"
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
        align="start"
        className="max-h-[var(--radix-popover-content-available-height)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
        collisionPadding={16}
        sideOffset={8}
      >
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">{t("selectDateRange")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("dateRangeLimit", {
              days: ADMIN_PAYMENT_OVERVIEW_MAX_DAYS,
            })}
          </p>
        </div>
        <Calendar
          autoFocus
          className="mx-auto"
          defaultMonth={draftRange.from}
          disabled={todayDate ? { after: todayDate } : undefined}
          excludeDisabled
          fixedWeeks
          locale={calendarLocale}
          mode="range"
          numberOfMonths={isDesktop ? 2 : 1}
          onSelect={handleRangeSelect}
          selected={draftRange.from ? draftRange : undefined}
          showOutsideDays={false}
        />
        <div className="sticky bottom-0 border-t bg-popover px-3 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div
              aria-live="polite"
              className={cn(
                "min-h-4 text-xs text-muted-foreground",
                (isFutureRange || exceedsLimit) && "text-destructive"
              )}
            >
              {isFutureRange
                ? t("futureDateError")
                : exceedsLimit
                  ? t("dateRangeTooLong", {
                      days: ADMIN_PAYMENT_OVERVIEW_MAX_DAYS,
                    })
                  : selectedDayCount
                    ? t("selectedDays", { days: selectedDayCount })
                    : t("completeDateRange")}
            </div>
            <Button
              className="sm:shrink-0"
              disabled={!canConfirm}
              onClick={confirmRange}
              size="sm"
              type="button"
            >
              <Check />
              {t("confirmDateRange")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
