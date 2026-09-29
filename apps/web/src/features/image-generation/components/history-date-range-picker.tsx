/**
 * 历史记录创建时间的 shadcn/ui 日期范围选择器。
 *
 * 使用方：HistoryFilters。组件仅维护日历弹层状态；选中的日历日期会转换成
 * 历史记录查询使用的 YYYY-MM-DD 字符串，不发起请求也不直接修改 URL。
 */
import { format } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";
import { Button } from "@repo/ui/components/button";
import { Calendar } from "@repo/ui/components/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/ui/components/popover";
import { CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";

type HistoryDateRangePickerProps = {
  createdFrom: string;
  createdTo: string;
  disabled: boolean;
  isZh: boolean;
  onRangeChange: (range: { createdFrom: string; createdTo: string }) => void;
};

/** 将可信的 ISO 日历日期解析成本地日期，避免 UTC 解析导致跨时区偏移。 */
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

/** 将日期转换成历史查询契约使用的 YYYY-MM-DD 字符串。 */
function formatCalendarDate(date: Date | undefined): string {
  return date ? format(date, "yyyy-MM-dd") : "";
}

/**
 * 选择并清除历史记录的创建日期范围。
 *
 * @param props 当前未提交的筛选值与范围变化回调。
 * @returns 使用 shadcn/ui Calendar 范围模式的可访问日期选择器。
 * @sideEffects 用户选择或清除日期时通知父组件更新本地筛选状态。
 */
export function HistoryDateRangePicker({
  createdFrom,
  createdTo,
  disabled,
  isZh,
  onRangeChange,
}: HistoryDateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dateLocale = isZh ? zhCN : enUS;
  const selectedRange = useMemo(() => {
    const from = parseCalendarDate(createdFrom);
    const to = parseCalendarDate(createdTo);

    return from ? { from, to } : undefined;
  }, [createdFrom, createdTo]);
  const displayLabel = useMemo(() => {
    const from = parseCalendarDate(createdFrom);
    const to = parseCalendarDate(createdTo);
    const dateFormat = "PPP";

    if (from && to) {
      return `${format(from, dateFormat, { locale: dateLocale })} – ${format(to, dateFormat, { locale: dateLocale })}`;
    }
    if (from) return format(from, dateFormat, { locale: dateLocale });
    if (to)
      return `${isZh ? "截至 " : "Through "}${format(to, dateFormat, { locale: dateLocale })}`;
    return isZh ? "全部日期" : "All dates";
  }, [createdFrom, createdTo, dateLocale, isZh]);

  /** 将日历的范围选择同步为查询参数的日历日期。 */
  function handleRangeSelect(range: { from?: Date; to?: Date } | undefined) {
    onRangeChange({
      createdFrom: formatCalendarDate(range?.from),
      createdTo: formatCalendarDate(range?.to),
    });
  }

  /** 清除未提交的日期条件，同时保留其它筛选值。 */
  function clearRange(): void {
    onRangeChange({ createdFrom: "", createdTo: "" });
  }

  return (
    <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
      <span id="history-date-filter-label">
        {isZh ? "创建日期" : "Created date"}
      </span>
      <Popover onOpenChange={setIsOpen} open={isOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={isOpen}
            aria-labelledby="history-date-filter-label"
            className="min-w-0 justify-start font-normal text-foreground"
            disabled={disabled}
            type="button"
            variant="outline"
          >
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{displayLabel}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-auto max-w-[calc(100vw-2rem)] overflow-hidden p-0"
        >
          <Calendar
            disabled={disabled}
            locale={dateLocale}
            mode="range"
            numberOfMonths={2}
            onSelect={handleRangeSelect}
            selected={selectedRange}
          />
          <div className="border-t p-2">
            <Button
              className="w-full"
              disabled={disabled || (!createdFrom && !createdTo)}
              onClick={clearRange}
              size="sm"
              type="button"
              variant="ghost"
            >
              {isZh ? "清除日期" : "Clear dates"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
