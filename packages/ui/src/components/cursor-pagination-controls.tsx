"use client";

/**
 * 响应式游标分页控件。
 *
 * 使用方：历史、支付订单等稳定 keyset 列表。移动端展示紧凑页数，桌面端展示
 * 数字页码窗口；所有展示出的数字页码均可导航，具体的 cursor 或随机访问策略由
 * 使用方决定。
 */
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../utils";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
} from "./pagination";
import {
  formatPaginationPageLabel,
  type PaginationControlsItem,
} from "./pagination-controls";

export type CursorPaginationControlsProps = {
  page: number;
  totalPages: number;
  items: readonly PaginationControlsItem[];
  ariaLabel: string;
  currentPageLabel: string;
  pageLabelTemplate: string;
  currentPageLabelTemplate: string;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  onPageChange: (page: number) => void;
  hasPrevious: boolean;
  hasNext: boolean;
  disabled?: boolean;
  className?: string;
};

/**
 * 渲染 keyset 列表的响应式页码窗口、上一页和下一页。
 *
 * @param props - 页序号、游标可用性、本地化文案和导航回调。
 * @returns 总页数为一时返回 null，否则返回 shadcn/ui Pagination。
 */
export function CursorPaginationControls({
  page,
  totalPages,
  items,
  ariaLabel,
  currentPageLabel,
  pageLabelTemplate,
  currentPageLabelTemplate,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  onPageChange,
  hasPrevious,
  hasNext,
  disabled = false,
  className,
}: CursorPaginationControlsProps) {
  if (totalPages <= 1) return null;

  return (
    <Pagination aria-label={ariaLabel} className={cn("mx-0 w-auto", className)}>
      <PaginationContent>
        <PaginationItem>
          <PaginationLink asChild size="default">
            <button
              aria-label={previousLabel}
              disabled={disabled || !hasPrevious}
              onClick={onPrevious}
              type="button"
            >
              <ChevronLeftIcon />
              <span className="hidden sm:inline">{previousLabel}</span>
            </button>
          </PaginationLink>
        </PaginationItem>
        <PaginationItem className="sm:hidden">
          <span
            aria-current="page"
            className="flex h-9 min-w-20 items-center justify-center px-2 text-sm tabular-nums"
          >
            {currentPageLabel}
          </span>
        </PaginationItem>
        {renderDesktopCursorItems({
          currentPageLabelTemplate,
          disabled,
          items,
          onPageChange,
          page,
          pageLabelTemplate,
        })}
        <PaginationItem>
          <PaginationLink asChild size="default">
            <button
              aria-label={nextLabel}
              disabled={disabled || !hasNext}
              onClick={onNext}
              type="button"
            >
              <span className="hidden sm:inline">{nextLabel}</span>
              <ChevronRightIcon />
            </button>
          </PaginationLink>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

/** 生成桌面数字页码；当前页外的所有可见数字均可交互。 */
function renderDesktopCursorItems({
  currentPageLabelTemplate,
  disabled,
  items,
  onPageChange,
  page,
  pageLabelTemplate,
}: {
  currentPageLabelTemplate: string;
  disabled: boolean;
  items: readonly PaginationControlsItem[];
  onPageChange: (page: number) => void;
  page: number;
  pageLabelTemplate: string;
}): ReactNode[] {
  return items.map((item) => {
    if (typeof item !== "number") {
      return (
        <PaginationItem className="hidden sm:block" key={item}>
          <PaginationEllipsis />
        </PaginationItem>
      );
    }

    const isCurrent = item === page;
    if (isCurrent) {
      return (
        <PaginationItem className="hidden sm:block" key={item}>
          <PaginationLink
            aria-label={formatPaginationPageLabel(
              currentPageLabelTemplate,
              item
            )}
            asChild
            isActive
          >
            <span>{item}</span>
          </PaginationLink>
        </PaginationItem>
      );
    }

    return (
      <PaginationItem className="hidden sm:block" key={item}>
        <PaginationLink asChild>
          <button
            aria-label={formatPaginationPageLabel(pageLabelTemplate, item)}
            disabled={disabled}
            onClick={() => onPageChange(item)}
            type="button"
          >
            {item}
          </button>
        </PaginationLink>
      </PaginationItem>
    );
  });
}
