"use client";

/**
 * 响应式数字分页控件。
 *
 * 使用方：支持随机访问的表格和卡片列表。桌面端使用数字窗口，移动端使用
 * 页码选择器；两端均保留上一页和下一页，单页时不渲染导航。
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

export type PaginationControlsItem = number | "start-ellipsis" | "end-ellipsis";

export type PaginationControlsProps = {
  page: number;
  totalPages: number;
  items: readonly PaginationControlsItem[];
  ariaLabel: string;
  pageSelectLabel: string;
  previousLabel: string;
  nextLabel: string;
  getPageLabel: (page: number, isCurrent: boolean) => string;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * 渲染客户端状态驱动的统一分页导航。
 *
 * @param props - 当前页、总页数、共享窗口、本地化文案和变更回调。
 * @returns shadcn/ui Pagination；总页数为一时返回 null。
 */
export function PaginationControls({
  page,
  totalPages,
  items,
  ariaLabel,
  pageSelectLabel,
  previousLabel,
  nextLabel,
  getPageLabel,
  onPageChange,
  disabled = false,
  className,
}: PaginationControlsProps) {
  if (totalPages <= 1) return null;

  return (
    <Pagination aria-label={ariaLabel} className={cn("mx-0 w-auto", className)}>
      <PaginationContent>
        <PaginationItem>
          <PaginationLink asChild size="default">
            <button
              aria-label={previousLabel}
              disabled={disabled || page <= 1}
              onClick={() => onPageChange(page - 1)}
              type="button"
            >
              <ChevronLeftIcon />
              <span className="hidden sm:inline">{previousLabel}</span>
            </button>
          </PaginationLink>
        </PaginationItem>

        <li className="sm:hidden">
          <Select
            disabled={disabled}
            onValueChange={(value) => {
              const nextPage = Number(value);
              if (
                Number.isSafeInteger(nextPage) &&
                nextPage >= 1 &&
                nextPage <= totalPages
              ) {
                onPageChange(nextPage);
              }
            }}
            value={String(page)}
          >
            <SelectTrigger aria-label={pageSelectLabel} className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: totalPages }, (_, index) => index + 1).map(
                (pageNumber) => (
                  <SelectItem key={pageNumber} value={String(pageNumber)}>
                    {pageNumber} / {totalPages}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>
        </li>

        {renderDesktopItems(items, page, getPageLabel, disabled, onPageChange)}

        <PaginationItem>
          <PaginationLink asChild size="default">
            <button
              aria-label={nextLabel}
              disabled={disabled || page >= totalPages}
              onClick={() => onPageChange(page + 1)}
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

/** 生成只在桌面端展示的数字页码与省略号。 */
function renderDesktopItems(
  items: readonly PaginationControlsItem[],
  page: number,
  getPageLabel: (page: number, isCurrent: boolean) => string,
  disabled: boolean,
  onPageChange: (page: number) => void
): ReactNode[] {
  return items.map((item) => {
    if (typeof item !== "number") {
      return (
        <PaginationItem className="hidden sm:block" key={item}>
          <PaginationEllipsis />
        </PaginationItem>
      );
    }

    const isCurrent = item === page;
    return (
      <PaginationItem className="hidden sm:block" key={item}>
        {isCurrent ? (
          <PaginationLink
            aria-label={getPageLabel(item, true)}
            asChild
            isActive
          >
            <span>{item}</span>
          </PaginationLink>
        ) : (
          <PaginationLink asChild>
            <button
              aria-label={getPageLabel(item, false)}
              disabled={disabled}
              onClick={() => onPageChange(item)}
              type="button"
            >
              {item}
            </button>
          </PaginationLink>
        )}
      </PaginationItem>
    );
  });
}
