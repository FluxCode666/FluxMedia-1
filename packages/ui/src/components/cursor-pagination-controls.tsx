"use client";

/**
 * 仅支持顺序翻页的游标分页控件。
 *
 * 使用方：历史、支付订单等稳定 keyset 列表。只展示当前页和前后导航，避免
 * 误导用户或业务层执行不受支持的随机深页访问。
 */
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "../utils";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
} from "./pagination";

export type CursorPaginationControlsProps = {
  totalPages: number;
  ariaLabel: string;
  currentPageLabel: string;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  disabled?: boolean;
  className?: string;
};

/**
 * 渲染 keyset 列表当前页、上一页和下一页。
 *
 * @param props - 页序号、游标可用性、本地化文案和导航回调。
 * @returns 总页数为一时返回 null，否则返回 shadcn/ui Pagination。
 */
export function CursorPaginationControls({
  totalPages,
  ariaLabel,
  currentPageLabel,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
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
        <PaginationItem>
          <span
            aria-current="page"
            className="flex h-9 min-w-20 items-center justify-center px-2 text-sm tabular-nums"
          >
            {currentPageLabel}
          </span>
        </PaginationItem>
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
