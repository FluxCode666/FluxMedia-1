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
  pageLabelTemplate: string;
  currentPageLabelTemplate: string;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * 将可序列化页码文案模板转换为最终辅助标签。
 *
 * @param template - 包含零个或多个 `{page}` 占位符的本地化模板。
 * @param page - 要写入模板的有效页码。
 * @returns 替换全部页码占位符后的文案；无占位符时原样返回。
 */
export function formatPaginationPageLabel(
  template: string,
  page: number
): string {
  return template.replaceAll("{page}", String(page));
}

export type PaginationControlsViewModel = {
  page: number;
  totalPages: number;
  showNavigation: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  mobilePages: number[];
};

/**
 * 为响应式分页控件生成无副作用视图模型。
 *
 * @param page - 当前有效页码。
 * @param totalPages - 当前总页数。
 * @returns 前后导航状态和移动端完整页码选项。
 */
export function getPaginationControlsViewModel(
  page: number,
  totalPages: number
): PaginationControlsViewModel {
  const safeTotalPages = Number.isSafeInteger(totalPages)
    ? Math.max(1, totalPages)
    : 1;
  const safePage = Number.isSafeInteger(page)
    ? Math.min(safeTotalPages, Math.max(1, page))
    : 1;
  return {
    page: safePage,
    totalPages: safeTotalPages,
    showNavigation: safeTotalPages > 1,
    canGoPrevious: safePage > 1,
    canGoNext: safePage < safeTotalPages,
    mobilePages: Array.from(
      { length: safeTotalPages },
      (_, index) => index + 1
    ),
  };
}

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
  pageLabelTemplate,
  currentPageLabelTemplate,
  onPageChange,
  disabled = false,
  className,
}: PaginationControlsProps) {
  const viewModel = getPaginationControlsViewModel(page, totalPages);
  if (!viewModel.showNavigation) return null;

  return (
    <Pagination aria-label={ariaLabel} className={cn("mx-0 w-auto", className)}>
      <PaginationContent>
        <PaginationItem>
          <PaginationLink asChild size="default">
            <button
              aria-label={previousLabel}
              disabled={disabled || !viewModel.canGoPrevious}
              onClick={() => onPageChange(viewModel.page - 1)}
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
            value={String(viewModel.page)}
          >
            <SelectTrigger aria-label={pageSelectLabel} className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {viewModel.mobilePages.map((pageNumber) => (
                <SelectItem key={pageNumber} value={String(pageNumber)}>
                  {pageNumber} / {viewModel.totalPages}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </li>

        {renderDesktopItems(
          items,
          page,
          pageLabelTemplate,
          currentPageLabelTemplate,
          disabled,
          onPageChange
        )}

        <PaginationItem>
          <PaginationLink asChild size="default">
            <button
              aria-label={nextLabel}
              disabled={disabled || !viewModel.canGoNext}
              onClick={() => onPageChange(viewModel.page + 1)}
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
  pageLabelTemplate: string,
  currentPageLabelTemplate: string,
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
            aria-label={formatPaginationPageLabel(
              currentPageLabelTemplate,
              item
            )}
            asChild
            isActive
          >
            <span>{item}</span>
          </PaginationLink>
        ) : (
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
        )}
      </PaginationItem>
    );
  });
}
