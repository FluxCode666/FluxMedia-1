"use client";

/**
 * URL 驱动的响应式分页控件适配器。
 *
 * 使用方：支持随机页访问的 Server Component 列表。负责站内 push/replace、
 * 全局导航反馈和结果更新后的焦点恢复，不负责数据读取。
 */
import { getPaginationWindow } from "@repo/shared/pagination/state";
import { PaginationControls } from "@repo/ui/components/pagination-controls";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { requestNavigationFeedback } from "@/features/navigation/navigation-feedback-event";
import { usePathname, useRouter } from "@/i18n/routing";
import {
  buildPaginationHref,
  type PaginationUrlParamNames,
} from "./url-adapter";

export type UrlPaginationControlsProps = {
  page: number;
  totalPages: number;
  names: PaginationUrlParamNames;
  ariaLabel: string;
  pageSelectLabel: string;
  previousLabel: string;
  nextLabel: string;
  pageLabelTemplate: string;
  currentPageLabelTemplate: string;
  navigation?: "push" | "replace";
  focusTargetId?: string;
  className?: string;
};

/**
 * 渲染与当前 URL 同步的桌面数字分页和移动页码选择器。
 *
 * @param props - 已由服务端收敛的分页元数据、参数名和本地化文案。
 * @returns 单页时为 null，否则返回 URL 驱动的统一分页导航。
 * @sideEffects 用户翻页会启动路由导航；结果页更新后可恢复列表标题焦点。
 */
export function UrlPaginationControls({
  page,
  totalPages,
  names,
  ariaLabel,
  pageSelectLabel,
  previousLabel,
  nextLabel,
  pageLabelTemplate,
  currentPageLabelTemplate,
  navigation = "push",
  focusTargetId,
  className,
}: UrlPaginationControlsProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const previousPageRef = useRef(page);

  useEffect(() => {
    if (previousPageRef.current === page) return;
    previousPageRef.current = page;
    if (!focusTargetId) return;
    document.getElementById(focusTargetId)?.focus({ preventScroll: true });
  }, [focusTargetId, page]);

  return (
    <PaginationControls
      ariaLabel={ariaLabel}
      className={className}
      currentPageLabelTemplate={currentPageLabelTemplate}
      disabled={isPending}
      items={getPaginationWindow(page, totalPages)}
      nextLabel={nextLabel}
      onPageChange={(nextPage) => {
        const href = buildPaginationHref(
          pathname,
          new URLSearchParams(searchParams.toString()),
          names,
          { page: nextPage },
          "page"
        );
        startTransition(() => {
          requestNavigationFeedback(href);
          router[navigation](href);
        });
      }}
      page={page}
      pageLabelTemplate={pageLabelTemplate}
      pageSelectLabel={pageSelectLabel}
      previousLabel={previousLabel}
      totalPages={totalPages}
    />
  );
}
