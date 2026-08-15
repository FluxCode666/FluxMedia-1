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
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getOperationsDetailAction } from "./actions";
import { createLatestRequestGate } from "./latest-request-gate";
import {
  buildOperationsDetailTableModel,
  type OperationsDetailPage,
  type OperationsDetailSelection,
  type OperationsDetailTableLabels,
  parseOperationsDetailPage,
} from "./operations-detail-sheet-data";
import {
  applyOperationsDetailFailure,
  applyOperationsDetailPage,
  beginOperationsDetailRequest,
  createOperationsDetailContext,
  createOperationsDetailState,
  isOperationsDetailStateVisible,
  type OperationsDetailFailure,
} from "./operations-detail-sheet-state";

const PAGE_SIZE = 100;

export type OperationsDetailSheetProps = {
  open: boolean;
  query: OperationsDashboardQueryInput;
  selection: OperationsDetailSelection | null;
  onOpenChange: (open: boolean) => void;
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
  range: OperationsDetailPage["range"],
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
  const t = useTranslations("OperationsDashboard");
  const [state, setState] = useState(createOperationsDetailState);
  const stateRef = useRef(state);
  const requestGate = useRef(createLatestRequestGate());
  const context = useMemo(
    () => (selection ? createOperationsDetailContext(query, selection) : null),
    [query, selection]
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /** 立即隐藏已加载页并让关闭前的所有异步响应失效。 */
  const clearVisibleState = useCallback((): void => {
    requestGate.current.invalidate();
    const clearedState = createOperationsDetailState();
    stateRef.current = clearedState;
    setState(clearedState);
  }, []);

  /** 读取第一页或签名 cursor 页，响应提交前再次校验当前 selection。 */
  const loadPage = useCallback(
    async (append: boolean): Promise<void> => {
      if (!context) return;
      const requestId = requestGate.current.begin();
      const cursor = append ? stateRef.current.nextCursor : null;
      setState((current) =>
        beginOperationsDetailRequest(
          current,
          context.query,
          context.selection,
          append
        )
      );
      let result:
        | { data?: unknown; serverError?: unknown; validationErrors?: unknown }
        | undefined;
      try {
        result = await getOperationsDetailAction({
          ...context.query,
          selection: context.selection,
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
        const page = parseOperationsDetailPage(result.data, context.selection);
        setState((current) => applyOperationsDetailPage(current, page, append));
      } catch {
        setState((current) =>
          applyOperationsDetailFailure(current, "unavailable", append)
        );
      }
    },
    [context]
  );

  useEffect(() => {
    if (!open || !context) {
      clearVisibleState();
      return;
    }
    void loadPage(false);
    return () => requestGate.current.invalidate();
  }, [clearVisibleState, context, loadPage, open]);

  /** 受控关闭发生时同步清空可见状态，再通知父组件移除 selection。 */
  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      if (!nextOpen) clearVisibleState();
      onOpenChange(nextOpen);
    },
    [clearVisibleState, onOpenChange]
  );

  const labels = useMemo<OperationsDetailTableLabels>(
    () => ({
      selection: {
        cumulativeUsers: {
          title: t("detail.selection.cumulative_users.title"),
          description: t("detail.selection.cumulative_users.description"),
        },
        users: {
          title: t("detail.selection.users.title"),
          description: t("detail.selection.users.description"),
        },
        loginActivity: {
          title: t("detail.selection.login_activity.title"),
          description: t("detail.selection.login_activity.description"),
        },
        creationActivity: {
          title: t("detail.selection.creation_activity.title"),
          description: t("detail.selection.creation_activity.description"),
        },
        paymentActivity: {
          title: t("detail.selection.payment_activity.title"),
          description: t("detail.selection.payment_activity.description"),
        },
        retentionCohorts: {
          title:
            selection?.module === "growth" &&
            selection.detail === "retention_cohorts"
              ? t("detail.selection.retention_cohorts.title", {
                  date: selection.cohortDate,
                  day: selection.retentionDay,
                })
              : t("detail.selection.retention_cohorts.fallbackTitle"),
          description:
            selection?.module === "growth" &&
            selection.detail === "retention_cohorts"
              ? t("detail.selection.retention_cohorts.description", {
                  day: selection.retentionDay,
                })
              : t("detail.selection.retention_cohorts.fallbackDescription"),
        },
        orders: {
          title: t("detail.selection.orders.title"),
          description: t("detail.selection.orders.description"),
        },
        fulfilledOrders: {
          title: t("detail.selection.fulfilled_orders.title"),
          description: t("detail.selection.fulfilled_orders.description"),
        },
        paymentLifecycle: {
          title: t("detail.selection.payment_lifecycle.title"),
          description: t("detail.selection.payment_lifecycle.description"),
        },
        imageOutputs: {
          title: t("detail.selection.image_outputs.title"),
          description: t("detail.selection.image_outputs.description"),
        },
        videoOutputs: {
          title: t("detail.selection.video_outputs.title"),
          description: t("detail.selection.video_outputs.description"),
        },
        creditUsage: {
          title: t("detail.selection.credit_usage.title"),
          description: t("detail.selection.credit_usage.description"),
        },
      },
      columns: {
        user: t("detail.columns.user"),
        email: t("detail.columns.email"),
        role: t("detail.columns.role"),
        accountStatus: t("detail.columns.accountStatus"),
        businessTime: t("detail.columns.businessTime"),
        retention:
          selection?.module === "growth" &&
          selection.detail === "retention_cohorts"
            ? t("detail.columns.retention", {
                day: selection.retentionDay,
              })
            : t("detail.columns.retentionFallback"),
        order: t("detail.columns.order"),
        tradeNumber: t("detail.columns.tradeNumber"),
        userId: t("detail.columns.userId"),
        amount: t("detail.columns.amount"),
        orderStatus: t("detail.columns.orderStatus"),
        paymentEvent: t("detail.columns.paymentEvent"),
        createdAt: t("detail.columns.createdAt"),
        fulfilledAt: t("detail.columns.fulfilledAt"),
        taskId: t("detail.columns.taskId"),
        model: t("detail.columns.model"),
        media: t("detail.columns.media"),
        quantity: t("detail.columns.quantity"),
        videoSeconds: t("detail.columns.videoSeconds"),
        netCredits: t("detail.columns.netCredits"),
      },
      values: {
        unnamedUser: t("detail.values.unnamedUser"),
        banned: t("detail.values.banned"),
        normal: t("detail.values.normal"),
        retained: t("detail.values.retained"),
        notRetained: t("detail.values.notRetained"),
        image: t("detail.values.image"),
        video: t("detail.values.video"),
        seconds: (value) => t("detail.values.seconds", { value }),
        emptyValue: t("detail.values.emptyValue"),
      },
      roles: {
        user: t("detail.roles.user"),
        observer_admin: t("detail.roles.observer_admin"),
        admin: t("detail.roles.admin"),
        super_admin: t("detail.roles.super_admin"),
      },
      orderStatus: {
        pending: t("detail.orderStatus.pending"),
        paid: t("detail.orderStatus.paid"),
        fulfilled: t("detail.orderStatus.fulfilled"),
        failed: t("detail.orderStatus.failed"),
        expired: t("detail.orderStatus.expired"),
      },
      paymentEvent: {
        order_created: t("detail.paymentEvent.order_created"),
        checkout_ready: t("detail.paymentEvent.checkout_ready"),
        payment_confirmed: t("detail.paymentEvent.payment_confirmed"),
        fulfillment_succeeded: t("detail.paymentEvent.fulfillment_succeeded"),
        checkout_failed: t("detail.paymentEvent.checkout_failed"),
        fulfillment_attempt_failed: t(
          "detail.paymentEvent.fulfillment_attempt_failed"
        ),
        fulfillment_failed_terminal: t(
          "detail.paymentEvent.fulfillment_failed_terminal"
        ),
        expired: t("detail.paymentEvent.expired"),
      },
    }),
    [selection, t]
  );

  const stateIsVisible = context
    ? isOperationsDetailStateVisible(state, open, context)
    : false;
  const tableModel = useMemo(() => {
    if (!stateIsVisible || !state.selection || !state.range) return null;
    return buildOperationsDetailTableModel(
      createAccumulatedPage(
        state.selection,
        state.range,
        state.rows,
        state.nextCursor
      ),
      locale,
      labels
    );
  }, [
    labels,
    locale,
    stateIsVisible,
    state.nextCursor,
    state.range,
    state.rows,
    state.selection,
  ]);

  const title = tableModel?.title ?? t("detail.defaultTitle");
  const description = tableModel?.description ?? t("detail.defaultDescription");
  const hasActiveContext = open && context !== null;
  const visibleStatus = stateIsVisible
    ? state.status
    : hasActiveContext
      ? "loading"
      : "idle";
  const visibleRows = stateIsVisible ? state.rows : [];
  const visibleNextCursor = stateIsVisible ? state.nextCursor : null;
  const visibleError = stateIsVisible ? state.error : null;
  const isInitialLoading = visibleStatus === "loading";
  const isLoadingMore = visibleStatus === "loading_more";
  const errorMessage = visibleError
    ? t(`detail.failure.${visibleError}`)
    : null;

  return (
    <Sheet onOpenChange={handleOpenChange} open={open}>
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
            ? t("detail.loading")
            : isLoadingMore
              ? t("detail.loadingMore")
              : (errorMessage ??
                (visibleRows.length > 0
                  ? t("detail.loaded", { count: visibleRows.length })
                  : t("detail.empty")))}
        </div>

        {errorMessage && visibleRows.length > 0 ? (
          <div className="flex shrink-0 items-start gap-3 border-b bg-destructive/5 px-5 py-3 text-sm text-destructive sm:px-6">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4" />
            <p className="flex-1">
              {t("detail.retainedRows", { error: errorMessage })}
            </p>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {isInitialLoading ? (
            <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
              <Loader2
                aria-hidden="true"
                className="mr-2 size-4 animate-spin motion-reduce:animate-none"
              />
              {t("detail.loadingShort")}
            </div>
          ) : visibleStatus === "error" ? (
            <div className="mx-auto flex min-h-64 max-w-md flex-col items-center justify-center px-6 text-center">
              <TriangleAlert
                aria-hidden="true"
                className="mb-3 size-6 text-destructive"
              />
              <p className="text-sm text-muted-foreground">
                {errorMessage ?? t("detail.failure.unavailable")}
              </p>
              <Button
                className="mt-5 min-h-11"
                onClick={() => void loadPage(false)}
                type="button"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" className="size-4" />
                {t("detail.actions.retry")}
              </Button>
            </div>
          ) : tableModel && tableModel.rows.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t("detail.emptyRange")}
            </div>
          ) : tableModel ? (
            <table className="w-max min-w-full border-collapse text-sm">
              <caption className="sr-only">
                {t("detail.caption", {
                  title,
                  count: tableModel.rows.length,
                })}
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

        {tableModel && (visibleNextCursor || errorMessage) ? (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-4 sm:px-6">
            <p className="text-xs text-muted-foreground">
              {t("detail.loadedShort", {
                count: visibleRows.length.toLocaleString(locale),
              })}
            </p>
            {visibleNextCursor ? (
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
                  ? t("detail.actions.loading")
                  : errorMessage
                    ? t("detail.actions.retryMore")
                    : t("detail.actions.more")}
              </Button>
            ) : null}
          </footer>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
