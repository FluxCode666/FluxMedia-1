"use client";

/**
 * 运营总览记录级核对 Sheet。
 *
 * 使用方：OperationsDashboardPanel 的增长指标、Cohort、商业化和内容下钻入口。
 * 组件通过管理员 Server Action 读取同源明细，使用签名 cursor 继续加载；桌面宽度不
 * 超过视口三分之二，手机全屏，并以原生语义表格呈现完整管理员核对字段。
 */
import type { OperationsDashboardQueryInput } from "@repo/shared/operations-dashboard/contracts";
import { Button } from "@repo/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/components/sheet";
import { cn } from "@repo/ui/utils";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getOperationsDetailAction } from "./actions";
import {
  buildOperationsDetailTableModel,
  type OperationsDetailPage,
  type OperationsDetailSelection,
  parseOperationsDetailPage,
} from "./operations-detail-sheet-data";
import {
  applyOperationsDetailFailure,
  applyOperationsDetailPage,
  beginOperationsDetailRequest,
  createOperationsDetailRequestGate,
  createOperationsDetailState,
  type OperationsDetailFailure,
} from "./operations-detail-sheet-state";

const PAGE_SIZE = 100;

export type OperationsDetailSheetProps = {
  open: boolean;
  query: OperationsDashboardQueryInput;
  selection: OperationsDetailSelection | null;
  onOpenChange: (open: boolean) => void;
};

const FAILURE_COPY: Record<OperationsDetailFailure, string> = {
  validation_error: "当前明细条件无效，请关闭后重新选择。",
  not_ready: "运营统计起点尚未初始化，暂时无法读取明细。",
  rate_limited: "明细请求过于频繁，请稍后重试。",
  timeout: "明细读取超时，请重试。",
  unavailable: "明细暂不可用，请稍后重试。",
};

/** 将 Action 层错误或缺失数据收敛为不泄露内部细节的失败状态。 */
function resolveActionFailure(result: {
  data?: unknown;
  serverError?: unknown;
  validationErrors?: unknown;
}): OperationsDetailFailure {
  if (result.validationErrors) return "validation_error";
  return "unavailable";
}

/** 为累计页构造展示模型，range 和 selection 固定来自第一页。 */
function createAccumulatedPage(
  selection: OperationsDetailSelection,
  range: Record<string, unknown>,
  rows: OperationsDetailPage["rows"],
  nextCursor: string | null
): OperationsDetailPage {
  return { selection, range, rows, nextCursor };
}

/**
 * 渲染可恢复、可继续加载的管理员明细抽屉。
 *
 * @param props 当前全局查询、合法明细 selection、开关及关闭回调。
 * @returns 包含 loading、empty、error、keyset 更多和响应式语义表格的 Sheet。
 * @sideEffects 打开、重试或继续加载时调用 `operations.getDetail` Action。
 */
export function OperationsDetailSheet({
  open,
  query,
  selection,
  onOpenChange,
}: OperationsDetailSheetProps) {
  const locale = useLocale();
  const [state, setState] = useState(createOperationsDetailState);
  const stateRef = useRef(state);
  const requestGate = useRef(createOperationsDetailRequestGate());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /** 读取第一页或签名 cursor 页，响应提交前再次校验当前 selection。 */
  const loadPage = useCallback(
    async (append: boolean): Promise<void> => {
      if (!selection) return;
      const requestId = requestGate.current.begin();
      const cursor = append ? stateRef.current.nextCursor : null;
      setState((current) =>
        beginOperationsDetailRequest(current, query, selection, append)
      );
      let result:
        | { data?: unknown; serverError?: unknown; validationErrors?: unknown }
        | undefined;
      try {
        result = await getOperationsDetailAction({
          ...query,
          selection,
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
      } catch {
        result = undefined;
      }
      if (!requestGate.current.isLatest(requestId)) return;
      if (!result?.data) {
        setState((current) =>
          applyOperationsDetailFailure(
            current,
            result ? resolveActionFailure(result) : "unavailable",
            append
          )
        );
        return;
      }
      try {
        const page = parseOperationsDetailPage(result.data, selection);
        setState((current) => applyOperationsDetailPage(current, page, append));
      } catch {
        setState((current) =>
          applyOperationsDetailFailure(current, "unavailable", append)
        );
      }
    },
    [query, selection]
  );

  useEffect(() => {
    if (!open || !selection) return;
    void loadPage(false);
  }, [loadPage, open, selection]);

  const tableModel = useMemo(() => {
    if (!state.selection || !state.range) return null;
    return buildOperationsDetailTableModel(
      createAccumulatedPage(
        state.selection,
        state.range,
        state.rows,
        state.nextCursor
      ),
      locale
    );
  }, [locale, state.nextCursor, state.range, state.rows, state.selection]);

  const title = tableModel?.title ?? "运营明细";
  const description =
    tableModel?.description ?? "按当前日期范围读取同源核对记录。";
  const isInitialLoading = state.status === "loading";
  const isLoadingMore = state.status === "loading_more";
  const errorMessage = state.error ? FAILURE_COPY[state.error] : null;

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        aria-busy={isInitialLoading || isLoadingMore}
        className="flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden p-0 sm:w-[min(66.666vw,72rem)] sm:max-w-none"
        side="right"
      >
        <SheetHeader className="shrink-0 border-b px-5 py-5 pr-14 text-left sm:px-6">
          <SheetTitle className="font-serif text-xl font-medium">
            {title}
          </SheetTitle>
          <SheetDescription className="max-w-3xl leading-relaxed">
            {description}
          </SheetDescription>
        </SheetHeader>

        <div aria-live="polite" className="sr-only" role="status">
          {isInitialLoading
            ? "正在加载运营明细"
            : isLoadingMore
              ? "正在加载更多运营明细"
              : (errorMessage ??
                (state.rows.length > 0
                  ? `已加载 ${state.rows.length} 条运营明细`
                  : "运营明细为空"))}
        </div>

        {errorMessage && state.rows.length > 0 ? (
          <div className="flex shrink-0 items-start gap-3 border-b bg-destructive/5 px-5 py-3 text-sm text-destructive sm:px-6">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4" />
            <p className="flex-1">{errorMessage} 已加载记录仍保留。</p>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {isInitialLoading ? (
            <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
              <Loader2
                aria-hidden="true"
                className="mr-2 size-4 animate-spin motion-reduce:animate-none"
              />
              正在加载明细
            </div>
          ) : state.status === "error" ? (
            <div className="mx-auto flex min-h-64 max-w-md flex-col items-center justify-center px-6 text-center">
              <TriangleAlert
                aria-hidden="true"
                className="mb-3 size-6 text-destructive"
              />
              <p className="text-sm text-muted-foreground">
                {errorMessage ?? FAILURE_COPY.unavailable}
              </p>
              <Button
                className="mt-5 min-h-11"
                onClick={() => void loadPage(false)}
                type="button"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" className="size-4" />
                重试
              </Button>
            </div>
          ) : tableModel && tableModel.rows.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              当前筛选范围没有可核对的明细记录。
            </div>
          ) : tableModel ? (
            <table className="w-max min-w-full border-collapse text-sm">
              <caption className="sr-only">
                {title}，共已加载 {tableModel.rows.length} 条记录
              </caption>
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b">
                  {tableModel.columns.map((column, index) => (
                    <th
                      className={cn(
                        "whitespace-nowrap bg-background px-4 py-3 text-left text-xs font-semibold text-muted-foreground",
                        index === 0 && "sticky left-0 z-20 border-r",
                        column.numeric && "text-right"
                      )}
                      key={column.key}
                      scope="col"
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableModel.rows.map((row) => (
                  <tr className="border-b last:border-b-0" key={row.key}>
                    {row.cells.map((cell, index) => (
                      <td
                        className={cn(
                          "max-w-80 whitespace-pre-line px-4 py-3 align-top leading-relaxed",
                          index === 0 &&
                            "sticky left-0 border-r bg-background font-medium",
                          tableModel.columns[index]?.numeric &&
                            "text-right font-mono tabular-nums"
                        )}
                        key={
                          tableModel.columns[index]?.key ??
                          `${row.key}-${index}`
                        }
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>

        {tableModel && (state.nextCursor || errorMessage) ? (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-4 sm:px-6">
            <p className="text-xs text-muted-foreground">
              已加载 {state.rows.length.toLocaleString(locale)} 条
            </p>
            {state.nextCursor ? (
              <Button
                className="min-h-11"
                disabled={isLoadingMore}
                onClick={() => void loadPage(true)}
                type="button"
                variant="outline"
              >
                {isLoadingMore ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-4 animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                {isLoadingMore
                  ? "加载中"
                  : errorMessage
                    ? "重试加载更多"
                    : "加载更多"}
              </Button>
            ) : null}
          </footer>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
