/**
 * 运营总览日期范围、快捷范围和趋势粒度筛选器。
 *
 * 使用方：OperationsDashboardPanel。自定义日历只维护本地草稿；应用后由父组件通过
 * UOL 刷新全页。日期不设最大跨度，但拒绝未来、反向和不完整范围。
 */
"use client";

import type {
  OperationsDashboardQueryInput,
  OperationsDateRangeInput,
  OperationsGranularity,
} from "@repo/shared/operations-dashboard/contracts";
import { operationsDashboardQueryInputSchema } from "@repo/shared/operations-dashboard/contracts";
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
import { format } from "date-fns";
import { CalendarRange } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

type DateRangeDraft = { from: string; to: string };
type CalendarRangeValue = { from?: Date; to?: Date };

type OperationsDashboardFilterProps = {
  query: OperationsDashboardQueryInput;
  appliedRange: { from: string; to: string; today: string };
  disabled?: boolean;
  onApply: (query: OperationsDashboardQueryInput) => void;
};

/** 将 Gregorian 字符串转换为仅供日历显示的本地 Date。 */
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

/** 把日历 Date 转为 URL/UOL 使用的 YYYY-MM-DD。 */
function formatCalendarDate(value: Date | undefined): string {
  return value ? format(value, "yyyy-MM-dd") : "";
}

/** 窄屏单月、桌面双月，避免手机日历溢出。 */
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

/** 判断自定义范围草稿是否可以提交。 */
function isValidDraft(draft: DateRangeDraft, today: string): boolean {
  return (
    Boolean(draft.from && draft.to) &&
    draft.from <= draft.to &&
    draft.to <= today &&
    operationsDashboardQueryInputSchema.safeParse({
      granularity: "day",
      range: { kind: "custom", from: draft.from, to: draft.to },
    }).success
  );
}

/** 渲染不自动查询的范围草稿，以及立即应用的快捷范围和粒度按钮。 */
export function OperationsDashboardFilter({
  query,
  appliedRange,
  disabled = false,
  onApply,
}: OperationsDashboardFilterProps) {
  const t = useTranslations("OperationsDashboard");
  const locale = useLocale();
  const calendarLocale = locale === "zh" ? calendarZhCN : calendarEnUS;
  const isDesktop = useDesktopCalendar();
  const todayDate = parseCalendarDate(appliedRange.today);
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<DateRangeDraft>({
    from: appliedRange.from,
    to: appliedRange.to,
  });
  useEffect(() => {
    setDraft({ from: appliedRange.from, to: appliedRange.to });
  }, [appliedRange.from, appliedRange.to]);
  const draftCalendarRange = useMemo(
    () => ({
      from: parseCalendarDate(draft.from),
      to: parseCalendarDate(draft.to),
    }),
    [draft.from, draft.to]
  );

  /** 应用一个快捷范围，同时保留当前粒度。 */
  function applyRange(range: OperationsDateRangeInput): void {
    onApply({ granularity: query.granularity, range });
  }

  /** 应用粒度，同时保留当前日期范围语义。 */
  function applyGranularity(granularity: OperationsGranularity): void {
    onApply({ granularity, range: query.range });
  }

  /** 提交完整自定义范围；非法草稿保留在弹层中供修正。 */
  function applyCustomRange(): void {
    if (!isValidDraft(draft, appliedRange.today)) return;
    setIsOpen(false);
    onApply({
      granularity: query.granularity,
      range: { kind: "custom", from: draft.from, to: draft.to },
    });
  }

  return (
    <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
      <div className="flex flex-wrap gap-2">
        <Popover onOpenChange={setIsOpen} open={isOpen}>
          <PopoverTrigger asChild>
            <Button
              className="min-h-11 justify-start gap-2 shadow-none"
              disabled={disabled}
              type="button"
              variant="outline"
            >
              <CalendarRange aria-hidden="true" className="size-4" />
              <span>
                {appliedRange.from} – {appliedRange.to}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="max-h-[var(--radix-popover-content-available-height)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
            collisionPadding={16}
          >
            <div className="border-b px-4 py-3">
              <p className="text-sm font-medium">{t("filter.custom")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("filter.customHint")}
              </p>
            </div>
            <Calendar
              autoFocus
              className="mx-auto"
              defaultMonth={draftCalendarRange.from}
              disabled={todayDate ? { after: todayDate } : undefined}
              fixedWeeks
              locale={calendarLocale}
              mode="range"
              numberOfMonths={isDesktop ? 2 : 1}
              onSelect={(range: CalendarRangeValue | undefined) =>
                setDraft({
                  from: formatCalendarDate(range?.from),
                  to: formatCalendarDate(range?.to),
                })
              }
              resetOnSelect
              selected={
                draftCalendarRange.from ? draftCalendarRange : undefined
              }
              showOutsideDays={false}
            />
            <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
              <p className="text-xs text-muted-foreground">
                {isValidDraft(draft, appliedRange.today)
                  ? `${draft.from} – ${draft.to}`
                  : t("filter.invalidRange")}
              </p>
              <Button
                disabled={!isValidDraft(draft, appliedRange.today) || disabled}
                onClick={applyCustomRange}
                type="button"
              >
                {t("actions.apply")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {(["this_week", "this_month", "this_year"] as const).map((kind) => (
          <Button
            aria-pressed={query.range.kind === kind}
            className="min-h-11 shadow-none"
            disabled={disabled}
            key={kind}
            onClick={() => applyRange({ kind })}
            type="button"
            variant={query.range.kind === kind ? "secondary" : "outline"}
          >
            {t(`filter.preset.${kind}`)}
          </Button>
        ))}
      </div>
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="mr-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t("filter.granularityLabel")}
        </legend>
        {(["day", "week", "month"] as const).map((granularity) => (
          <Button
            aria-pressed={query.granularity === granularity}
            className="min-h-11 min-w-16 shadow-none"
            disabled={disabled}
            key={granularity}
            onClick={() => applyGranularity(granularity)}
            type="button"
            variant={
              query.granularity === granularity ? "secondary" : "outline"
            }
          >
            {t(`filter.granularity.${granularity}`)}
          </Button>
        ))}
      </fieldset>
    </div>
  );
}
