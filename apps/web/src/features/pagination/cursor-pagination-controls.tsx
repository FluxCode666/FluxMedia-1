"use client";

/**
 * URL 驱动的 keyset 分页控件适配器。
 *
 * 使用方：历史与支付订单列表。每次导航原子更新可见页序号和不透明 cursor，
 * 不提供任意页码跳转。
 */
import { CursorPaginationControls } from "@repo/ui/components/cursor-pagination-controls";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { requestNavigationFeedback } from "@/features/navigation/navigation-feedback-event";
import { usePathname, useRouter } from "@/i18n/routing";
import {
  buildPaginationHref,
  type PaginationUrlParamNames,
} from "./url-adapter";

export type UrlCursorPaginationControlsProps = {
  page: number;
  totalPages: number;
  previousCursor: string | null;
  nextCursor: string | null;
  names: PaginationUrlParamNames;
  ariaLabel: string;
  currentPageLabel: string;
  previousLabel: string;
  nextLabel: string;
  focusTargetId?: string;
  className?: string;
};

/**
 * 渲染 URL 驱动的游标上一页/下一页导航。
 *
 * @param props - 当前页、总页数、双向 cursor、参数名和本地化文案。
 * @returns 单页时为 null，否则返回顺序分页导航。
 * @sideEffects 用户导航时 push 新 URL 并触发全局导航反馈。
 */
export function UrlCursorPaginationControls({
  page,
  totalPages,
  previousCursor,
  nextCursor,
  names,
  ariaLabel,
  currentPageLabel,
  previousLabel,
  nextLabel,
  focusTargetId,
  className,
}: UrlCursorPaginationControlsProps) {
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

  const navigate = (targetPage: number, cursor: string) => {
    const href = buildPaginationHref(
      pathname,
      new URLSearchParams(searchParams.toString()),
      names,
      { cursor, page: targetPage },
      "page"
    );
    startTransition(() => {
      requestNavigationFeedback(href);
      router.push(href);
    });
  };

  return (
    <CursorPaginationControls
      ariaLabel={ariaLabel}
      className={className}
      currentPageLabel={currentPageLabel}
      disabled={isPending}
      hasNext={nextCursor !== null}
      hasPrevious={previousCursor !== null}
      nextLabel={nextLabel}
      onNext={() => {
        if (nextCursor) navigate(page + 1, nextCursor);
      }}
      onPrevious={() => {
        if (previousCursor) navigate(Math.max(1, page - 1), previousCursor);
      }}
      previousLabel={previousLabel}
      totalPages={totalPages}
    />
  );
}
