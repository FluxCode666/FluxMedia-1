/**
 * 支付概览的 shadcn/ui 日期范围选择器。
 *
 * 使用方：管理端支付概览页。组件维护尚未应用的日期范围，使用 Calendar、Popover
 * 与 Button 完成选择，只有点击应用后才以白名单 URL 触发服务端重新聚合。
 */
"use client";

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
import { CalendarRange, Check, RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";

import { useRouter } from "@/i18n/routing";

import { buildAdminPaymentOverviewHref } from "./admin-payment-query";

type PaymentOverviewDateRangePickerProps = {
  startDate: string;
  endDate: string;
  currentMonthStartDate: string;
  currentMonthEndDate: string;
  today: string;
};

type CalendarRangeValue = {
  from?: Date;
  to?: Date;
};

/** 将可信的 YYYY-MM-DD 转为本地日历日期，避免 UTC 字符串解析造成日期偏移。 */
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

/** 监听桌面断点，让手机日历保持单月、桌面日历展示双月。 */
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
 * 渲染支付报表日期范围并在确认后更新 URL。
 *
 * @param props 已应用范围、当前自然月范围与报告时区中的今天。
 * @returns 响应式 shadcn/ui 日期范围选择器。
 * @sideEffects 点击应用时触发同源客户端导航；选择过程不发起查询。
 */
export function PaymentOverviewDateRangePicker({
  startDate,
  endDate,
  currentMonthStartDate,
  currentMonthEndDate,
  today,
}: PaymentOverviewDateRangePickerProps) {
  const locale = useLocale();
  const t = useTranslations("AdminPayments.overview");
  const router = useRouter();
  const isDesktop = useDesktopCalendar();
  const [isOpen, setIsOpen] = useState(false);
  const [isNavigating, startTransition] = useTransition();
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
  const maxSelectableDate = parseCalendarDate(currentMonthEndDate);
  const selectedDayCount =
    draftRange.from && draftRange.to
      ? differenceInCalendarDays(draftRange.to, draftRange.from) + 1
      : null;
  const startsInFuture = Boolean(draftStartDate && draftStartDate > today);
  const exceedsLimit = Boolean(
    selectedDayCount && selectedDayCount > ADMIN_PAYMENT_OVERVIEW_MAX_DAYS
  );
  const canApply = Boolean(
    draftRange.from &&
      draftRange.to &&
      !startsInFuture &&
      !exceedsLimit &&
      !isNavigating
  );
  const displayLabel = appliedRange.from
    ? appliedRange.to
      ? `${format(appliedRange.from, "PP", { locale: calendarLocale })} – ${format(appliedRange.to, "PP", { locale: calendarLocale })}`
      : format(appliedRange.from, "PP", { locale: calendarLocale })
    : t("selectDateRange");

  /** 打开时恢复已应用范围，关闭时丢弃未确认的草稿。 */
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

  /** 将草稿快速恢复为部署时区下的当前完整自然月。 */
  function selectCurrentMonth(): void {
    setDraftStartDate(currentMonthStartDate);
    setDraftEndDate(currentMonthEndDate);
  }

  /** 应用完整合法范围；相同范围只关闭弹层，不产生重复导航。 */
  function applyRange(): void {
    if (!canApply) return;
    if (draftStartDate === startDate && draftEndDate === endDate) {
      setIsOpen(false);
      return;
    }
    const href = buildAdminPaymentOverviewHref({
      startDate: draftStartDate,
      endDate: draftEndDate,
    });
    setIsOpen(false);
    startTransition(() => router.push(href));
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={isOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={isOpen}
          className="h-auto min-h-9 w-full justify-start gap-2 px-3 py-2 font-normal sm:w-auto sm:min-w-[280px]"
          disabled={isNavigating}
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
        className="max-h-[calc(100vh-2rem)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
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
          disabled={
            maxSelectableDate ? { after: maxSelectableDate } : undefined
          }
          excludeDisabled
          locale={calendarLocale}
          mode="range"
          numberOfMonths={isDesktop ? 2 : 1}
          onSelect={handleRangeSelect}
          selected={draftRange.from ? draftRange : undefined}
        />
        <div className="sticky bottom-0 border-t bg-popover px-3 py-3">
          <div
            aria-live="polite"
            className={cn(
              "mb-3 min-h-4 text-xs text-muted-foreground",
              (startsInFuture || exceedsLimit) && "text-destructive"
            )}
          >
            {startsInFuture
              ? t("futureStartError")
              : exceedsLimit
                ? t("dateRangeTooLong", {
                    days: ADMIN_PAYMENT_OVERVIEW_MAX_DAYS,
                  })
                : selectedDayCount
                  ? t("selectedDays", { days: selectedDayCount })
                  : t("completeDateRange")}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button
              disabled={isNavigating}
              onClick={selectCurrentMonth}
              size="sm"
              type="button"
              variant="ghost"
            >
              <RotateCcw />
              {t("currentMonth")}
            </Button>
            <Button
              disabled={!canApply}
              onClick={applyRange}
              size="sm"
              type="button"
            >
              <Check />
              {t("applyDateRange")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
