/**
 * 管理端运营总览的客户端页面主体。
 *
 * 使用方：`/dashboard/admin/operations` Server Component。组件统一管理筛选、刷新、
 * 完整快照竞态、特殊状态、图表、同源明细与异步导出，任何失败都不会用半成品替换
 * 最近一次成功快照。
 */
"use client";

import type {
  OperationsDashboardQueryInput,
  OperationsExportTask,
  OperationsPaymentLifecycleStage,
} from "@repo/shared/operations-dashboard/contracts";
import type { OperationsNumericSeriesBucket } from "@repo/shared/operations-dashboard/series";
import { Button } from "@repo/ui/components/button";
import { cn } from "@repo/ui/utils";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useRouter } from "@/i18n/routing";
import type { OperationsDashboardActionFailure } from "./action-result";
import {
  getOperationsOverviewAction,
  type OperationsDashboardOverviewActionResult,
} from "./actions";
import {
  OperationsCohortChart,
  OperationsGrowthTrendChart,
  OperationsImageChart,
  OperationsNetCreditsChart,
  OperationsPaymentLifecycleChart,
  OperationsVideoChart,
} from "./charts";
import type { OperationsGrowthRetentionMetric } from "./growth-service";
import { OperationsDashboardCohort } from "./operations-dashboard-cohort";
import { OperationsDashboardCommercial } from "./operations-dashboard-commercial";
import { OperationsDashboardExports } from "./operations-dashboard-exports";
import { OperationsDashboardFilter } from "./operations-dashboard-filter";
import {
  formatCountComparison,
  formatOperationsDateTime,
  formatOperationsNumber,
  formatOperationsRate,
  formatPercentagePointChange,
} from "./operations-dashboard-format";
import { OperationsDashboardHealth } from "./operations-dashboard-health";
import { OperationsMetricCard } from "./operations-dashboard-metric-card";
import { buildOperationsDashboardHref } from "./operations-dashboard-query";
import type { OperationsDashboardOverview } from "./operations-dashboard-service";
import {
  applyOperationsDashboardFailure,
  applyOperationsDashboardSnapshot,
  beginOperationsDashboardRequest,
  createOperationsDashboardRequestGate,
  type OperationsDashboardViewState,
} from "./operations-dashboard-state";
import {
  OperationsDetailSheet,
  type OperationsDetailSheetProps,
} from "./operations-detail-sheet";
import type { OperationsDetailSelection } from "./operations-detail-sheet-data";

type OperationsDashboardPanelProps = {
  currentUserId: string;
  initialSnapshot: OperationsDashboardOverview | null;
  initialQuery: OperationsDashboardQueryInput;
  initialFailureStatus?: OperationsDashboardActionFailure | null;
  initialExports: OperationsExportTask[];
  initialExportsNextCursor: string | null;
  initialExportsLoadFailed?: boolean;
  invalidDeepLinkHref?: string | null;
};

type RetentionKey = "d1Retention" | "d7Retention" | "d30Retention";

const RETENTION_KEYS: readonly RetentionKey[] = [
  "d1Retention",
  "d7Retention",
  "d30Retention",
];

/** 只复制服务端真实桶的应用日期边界，不把展示标签或降采样索引写入 selection。 */
function createDetailBucket(bucket: OperationsNumericSeriesBucket): {
  from: string;
  to: string;
} {
  return { from: bucket.from, to: bucket.to };
}

/** 将商业化图表字段名转换为共享契约使用的稳定阶段值。 */
function resolvePaymentDetailStage(
  stage: keyof OperationsDashboardOverview["commercial"]["lifecycle"]
): OperationsPaymentLifecycleStage {
  switch (stage) {
    case "createdOrders":
      return "created_orders";
    case "pendingOrders":
      return "pending_orders";
    case "paymentConfirmedOrders":
      return "payment_confirmed_orders";
    case "paidNotFulfilledOrders":
      return "paid_not_fulfilled_orders";
    case "fulfilledOrders":
      return "fulfilled_orders";
    case "failedOrders":
      return "failed_orders";
  }
}

/**
 * 同步已成功应用的筛选 URL，同时保留当前 locale 路径且不重复触发服务端页面查询。
 *
 * @param query 已由 UOL 返回完整成功快照的筛选条件。
 * @sideEffects 使用 History API 原地替换当前浏览器 URL，不新增历史记录。
 */
function replaceAppliedQueryUrl(query: OperationsDashboardQueryInput): void {
  const canonicalHref = buildOperationsDashboardHref(query);
  const queryIndex = canonicalHref.indexOf("?");
  const search = queryIndex >= 0 ? canonicalHref.slice(queryIndex) : "";
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search}`
  );
}

/** 将 Action 安全结果收敛为页面状态机支持的稳定失败码。 */
function resolveOverviewActionResult(
  result: { data?: OperationsDashboardOverviewActionResult } | undefined
): OperationsDashboardOverviewActionResult {
  return result?.data ?? { status: "unavailable" };
}

/** 将留存顶部指标格式化为真实比率或明确的上线前/未成熟状态。 */
function formatRetentionMetric(
  metric: OperationsGrowthRetentionMetric,
  locale: string,
  labels: { immature: string; preEpoch: string }
): { value: string; status: "value" | "immature" | "pre_epoch" } {
  if (metric.current.status === "value") {
    return {
      value: formatOperationsRate(metric.current.rate, locale),
      status: "value",
    };
  }
  if (metric.current.status === "pre_epoch") {
    return { value: labels.preEpoch, status: "pre_epoch" };
  }
  return { value: labels.immature, status: "immature" };
}

/** 将留存上期比较格式化为百分点；缺少可比样本时不伪造零变化。 */
function formatRetentionComparison(
  metric: OperationsGrowthRetentionMetric,
  locale: string,
  unavailable: string
): string {
  return metric.comparison.status === "value"
    ? formatPercentagePointChange(
        metric.comparison.changePercentagePoints,
        locale
      )
    : unavailable;
}

/**
 * 渲染运营总览完整单页。
 *
 * @param props 服务端首屏快照、查询、导出记录和安全失败状态。
 * @returns 增长、商业化、内容、健康、明细和导出工作流。
 * @sideEffects 筛选或刷新时调用管理员 UOL Action，并同步规范 URL。
 */
export function OperationsDashboardPanel({
  currentUserId,
  initialExports,
  initialExportsLoadFailed = false,
  initialExportsNextCursor,
  initialFailureStatus = null,
  initialQuery,
  initialSnapshot,
  invalidDeepLinkHref = null,
}: OperationsDashboardPanelProps) {
  const locale = useLocale();
  const t = useTranslations("OperationsDashboard");
  const router = useRouter();
  const [view, setView] = useState<OperationsDashboardViewState>({
    snapshot: initialSnapshot,
    query: initialQuery,
    requestStatus: initialSnapshot ? "idle" : "error",
    failureStatus: initialSnapshot
      ? null
      : (initialFailureStatus ?? "unavailable"),
  });
  const [liveMessage, setLiveMessage] = useState(
    invalidDeepLinkHref ? t("state.invalidDeepLink") : ""
  );
  const [detailSelection, setDetailSelection] =
    useState<OperationsDetailSelection | null>(null);
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const requestGate = useRef(createOperationsDashboardRequestGate());

  useEffect(() => {
    if (!invalidDeepLinkHref) return;
    router.replace(invalidDeepLinkHref, { scroll: false });
  }, [invalidDeepLinkHref, router]);

  useEffect(
    () => () => {
      requestGate.current.invalidate();
    },
    []
  );

  /** 请求一份完整一致快照，只有最新成功请求可以同时替换查询和页面数据。 */
  async function requestSnapshot(
    query: OperationsDashboardQueryInput
  ): Promise<void> {
    const requestId = requestGate.current.begin();
    setView((current) => beginOperationsDashboardRequest(current));
    setLiveMessage(t("state.loading"));
    let result: OperationsDashboardOverviewActionResult;
    try {
      result = resolveOverviewActionResult(
        await getOperationsOverviewAction(query)
      );
    } catch {
      result = { status: "unavailable" };
    }
    if (!requestGate.current.isLatest(requestId)) return;
    if (result.status === "ready") {
      setView((current) =>
        applyOperationsDashboardSnapshot(current, result.snapshot, query)
      );
      replaceAppliedQueryUrl(query);
      setLiveMessage(t("state.updated"));
      return;
    }
    setView((current) =>
      applyOperationsDashboardFailure(current, result.status)
    );
    setLiveMessage(t(`state.failure.${result.status}`));
  }

  /** 首屏失败与手动刷新均重用当前已应用查询，不读取日历未提交草稿。 */
  function refreshAppliedQuery(): void {
    void requestSnapshot(view.query);
  }

  /** 记录实际触发元素并打开对应明细，供受控 Sheet 关闭后恢复焦点。 */
  function openDetail(selection: OperationsDetailSelection): void {
    detailTriggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setDetailSelection(selection);
  }

  /** 关闭记录级明细、清空旧选择，并在 Sheet 卸载后恢复触发按钮焦点。 */
  function changeDetailOpen(open: boolean): void {
    if (open) return;
    const trigger = detailTriggerRef.current;
    detailTriggerRef.current = null;
    setDetailSelection(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }

  const isLoading = view.requestStatus === "loading";
  if (!view.snapshot) {
    return (
      <div aria-busy={isLoading} className="space-y-6">
        <header>
          <h1 className="font-serif text-3xl font-medium tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            {t("description")}
          </p>
        </header>
        <section
          className="flex min-h-64 flex-col items-center justify-center rounded-xl border px-6 text-center"
          role={isLoading ? "status" : "alert"}
        >
          {isLoading ? (
            <Loader2
              aria-hidden="true"
              className="mb-4 size-6 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <TriangleAlert
              aria-hidden="true"
              className="mb-4 size-6 text-destructive"
            />
          )}
          <h2 className="font-serif text-xl font-medium">
            {isLoading ? t("state.loadingTitle") : t("state.errorTitle")}
          </h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            {isLoading
              ? t("state.loadingDescription")
              : t(`state.failure.${view.failureStatus ?? "unavailable"}`)}
          </p>
          {!isLoading ? (
            <Button
              className="mt-5 min-h-11"
              onClick={refreshAppliedQuery}
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {t("actions.retry")}
            </Button>
          ) : null}
        </section>
        <p aria-live="polite" className="sr-only" role="status">
          {liveMessage}
        </p>
      </div>
    );
  }

  const snapshot = view.snapshot;
  const notComparable = t("status.not_comparable");
  const retentionLabels = {
    immature: t("status.immature"),
    preEpoch: t("status.pre_epoch"),
  };
  const countMetricCards = [
    {
      key: "cumulativeUsers" as const,
      selection: {
        module: "growth",
        detail: "cumulative_users",
        cutoffDate: snapshot.range.to,
      } as const,
    },
    {
      key: "newUsers" as const,
      selection: { module: "growth", detail: "users" } as const,
    },
    {
      key: "loginActiveUsers" as const,
      selection: { module: "growth", detail: "login_activity" } as const,
    },
    {
      key: "creationActiveUsers" as const,
      selection: { module: "growth", detail: "creation_activity" } as const,
    },
  ];
  const detailSheetProps: OperationsDetailSheetProps = {
    open: detailSelection !== null,
    query: view.query,
    selection: detailSelection,
    onOpenChange: changeDetailOpen,
  };

  return (
    <div aria-busy={isLoading} className="space-y-12">
      <header className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="font-serif text-3xl font-medium tracking-tight">
              {t("title")}
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              {t("description")}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("snapshotMeta", {
                timeZone: snapshot.timeZone,
                generatedAt: formatOperationsDateTime(
                  snapshot.generatedAt,
                  locale,
                  snapshot.timeZone
                ),
              })}
            </p>
          </div>
          <Button
            className="min-h-11 shadow-none"
            disabled={isLoading}
            onClick={refreshAppliedQuery}
            type="button"
            variant="outline"
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(
                "size-4",
                isLoading && "animate-spin motion-reduce:animate-none"
              )}
            />
            {t("actions.refresh")}
          </Button>
        </div>
        <OperationsDashboardFilter
          appliedRange={snapshot.range}
          disabled={isLoading}
          onApply={(query) => void requestSnapshot(query)}
          query={view.query}
        />
        {view.requestStatus === "stale" ? (
          <div
            className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4" />
            <p>{t(`state.failure.${view.failureStatus ?? "unavailable"}`)}</p>
          </div>
        ) : null}
      </header>

      <section aria-labelledby="operations-growth-title" className="space-y-5">
        <div>
          <h2
            className="font-serif text-2xl font-medium tracking-tight"
            id="operations-growth-title"
          >
            {t("growth.title")}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("growth.description")}
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {countMetricCards.map(({ key, selection }) => {
            const metric = snapshot.growth.metrics[key];
            return (
              <OperationsMetricCard
                action={
                  selection ? (
                    <Button
                      onClick={() => openDetail(selection)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("actions.reconcile")}
                    </Button>
                  ) : null
                }
                comparison={formatCountComparison(
                  metric.comparison,
                  locale,
                  notComparable
                )}
                description={t(`growth.metrics.${key}.description`)}
                key={key}
                status={metric.status}
                statusLabel={
                  metric.status === "pre_epoch"
                    ? t("status.pre_epoch")
                    : undefined
                }
                title={t(`growth.metrics.${key}.title`)}
                value={
                  metric.status === "pre_epoch"
                    ? t("status.pre_epoch")
                    : formatOperationsNumber(metric.current, locale)
                }
              />
            );
          })}
          {RETENTION_KEYS.map((key) => {
            const metric = snapshot.growth.metrics[key];
            const formatted = formatRetentionMetric(
              metric,
              locale,
              retentionLabels
            );
            return (
              <OperationsMetricCard
                comparison={formatRetentionComparison(
                  metric,
                  locale,
                  notComparable
                )}
                description={t(`growth.metrics.${key}.description`)}
                key={key}
                status={formatted.status}
                statusLabel={
                  formatted.status === "value"
                    ? undefined
                    : t(`status.${formatted.status}`)
                }
                title={t(`growth.metrics.${key}.title`)}
                value={formatted.value}
              />
            );
          })}
        </div>

        <OperationsGrowthTrendChart
          labels={{
            title: t("charts.growth.title"),
            description: t("charts.growth.description"),
            source: t("charts.source"),
            tableOpen: t("charts.tableOpen"),
            tableCaption: t("charts.growth.tableCaption"),
            date: t("charts.date"),
            preEpoch: t("status.pre_epoch"),
            navigation: t("charts.navigation"),
            series: {
              newUsers: t("growth.metrics.newUsers.title"),
              loginActiveUsers: t("growth.metrics.loginActiveUsers.title"),
              creationActiveUsers: t(
                "growth.metrics.creationActiveUsers.title"
              ),
              paymentActiveUsers: t("growth.metrics.paymentActiveUsers.title"),
            },
          }}
          locale={locale}
          onSelectPoint={({ activityKind, bucket }) =>
            openDetail({
              module: "growth",
              detail: "activity_bucket",
              activityKind,
              bucket: createDetailBucket(bucket),
            })
          }
          series={snapshot.growth.series}
        />

        <OperationsCohortChart
          cohorts={snapshot.growth.cohorts}
          labels={{
            title: t("charts.cohort.title"),
            description: t("charts.cohort.description"),
            source: t("charts.source"),
            tableOpen: t("charts.tableOpen"),
            tableCaption: t("charts.cohort.tableCaption"),
            date: t("charts.date"),
            cohortSize: t("growth.cohort.size"),
            retainedCount: t("charts.cohort.retainedCount"),
            rate: t("charts.cohort.rate"),
            immature: t("status.immature"),
            preEpoch: t("status.pre_epoch"),
            noData: t("status.no_data"),
            days: { d1: "D1", d7: "D7", d30: "D30" },
          }}
          locale={locale}
        />
        <OperationsDashboardCohort
          cohorts={snapshot.growth.cohorts}
          onOpenDetail={openDetail}
        />
      </section>

      <OperationsDashboardCommercial
        lifecycleChart={
          <OperationsPaymentLifecycleChart
            labels={{
              title: t("charts.payment.title"),
              description: t("charts.payment.description"),
              source: t("charts.source"),
              unit: t("charts.payment.unit"),
              tableOpen: t("charts.tableOpen"),
              tableCaption: t("charts.payment.tableCaption"),
              stage: t("charts.payment.stage"),
              status: t("charts.status"),
              valueStatus: t("status.value"),
              preEpoch: t("status.pre_epoch"),
              current: t("charts.current"),
              previous: t("charts.previous"),
              stages: {
                createdOrders: t("charts.payment.stages.createdOrders"),
                pendingOrders: t("charts.payment.stages.pendingOrders"),
                paymentConfirmedOrders: t(
                  "charts.payment.stages.paymentConfirmedOrders"
                ),
                paidNotFulfilledOrders: t(
                  "charts.payment.stages.paidNotFulfilledOrders"
                ),
                fulfilledOrders: t("charts.payment.stages.fulfilledOrders"),
                failedOrders: t("charts.payment.stages.failedOrders"),
              },
            }}
            lifecycle={snapshot.commercial.lifecycle}
            locale={locale}
            onSelectStage={(stage) =>
              openDetail({
                module: "commercialization",
                detail: "payment_stage",
                stage: resolvePaymentDetailStage(stage),
              })
            }
          />
        }
        onOpenDetail={openDetail}
        snapshot={snapshot.commercial}
      />

      <section aria-labelledby="operations-content-title" className="space-y-5">
        <div>
          <h2
            className="font-serif text-2xl font-medium tracking-tight"
            id="operations-content-title"
          >
            {t("content.title")}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("content.description")}
          </p>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <OperationsImageChart
            labels={{
              title: t("charts.image.title"),
              description: t("charts.image.description"),
              source: t("charts.source"),
              series: t("charts.image.series"),
              navigation: t("charts.navigation"),
              tableOpen: t("charts.tableOpen"),
              tableCaption: t("charts.image.tableCaption"),
              date: t("charts.date"),
              status: t("charts.status"),
              valueStatus: t("status.value"),
              value: t("charts.value"),
              preEpoch: t("status.pre_epoch"),
            }}
            locale={locale}
            onSelectPoint={(bucket) =>
              openDetail({
                module: "content",
                detail: "content_bucket",
                contentKind: "image",
                bucket: createDetailBucket(bucket),
              })
            }
            series={snapshot.content.series.imageCount}
          />
          <OperationsVideoChart
            countSeries={snapshot.content.series.videoCount}
            labels={{
              title: t("charts.video.title"),
              description: t("charts.video.description"),
              source: t("charts.source"),
              modeLabel: t("charts.video.modeLabel"),
              count: t("charts.video.count"),
              seconds: t("charts.video.seconds"),
              navigation: t("charts.navigation"),
              tableOpen: t("charts.tableOpen"),
              tableCaption: t("charts.video.tableCaption"),
              date: t("charts.date"),
              status: t("charts.status"),
              valueStatus: t("status.value"),
              value: t("charts.value"),
              preEpoch: t("status.pre_epoch"),
            }}
            locale={locale}
            onSelectPoint={(bucket) =>
              openDetail({
                module: "content",
                detail: "content_bucket",
                contentKind: "video",
                bucket: createDetailBucket(bucket),
              })
            }
            secondsSeries={snapshot.content.series.videoSeconds}
          />
        </div>
        <OperationsNetCreditsChart
          labels={{
            title: t("charts.credits.title"),
            description: t("charts.credits.description"),
            source: t("charts.source"),
            series: t("charts.credits.series"),
            navigation: t("charts.navigation"),
            tableOpen: t("charts.tableOpen"),
            tableCaption: t("charts.credits.tableCaption"),
            date: t("charts.date"),
            status: t("charts.status"),
            valueStatus: t("status.value"),
            value: t("charts.value"),
            preEpoch: t("status.pre_epoch"),
          }}
          locale={locale}
          onSelectPoint={(bucket) =>
            openDetail({
              module: "content",
              detail: "content_bucket",
              contentKind: "credits",
              bucket: createDetailBucket(bucket),
            })
          }
          series={snapshot.content.series.netCredits}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              openDetail({
                module: "content",
                detail: "image_outputs",
              })
            }
            type="button"
            variant="outline"
          >
            {t("content.reconcileImages")}
          </Button>
          <Button
            onClick={() =>
              openDetail({
                module: "content",
                detail: "video_outputs",
              })
            }
            type="button"
            variant="outline"
          >
            {t("content.reconcileVideos")}
          </Button>
          <Button
            onClick={() =>
              openDetail({
                module: "content",
                detail: "credit_usage",
              })
            }
            type="button"
            variant="outline"
          >
            {t("content.reconcileCredits")}
          </Button>
        </div>
      </section>

      <OperationsDashboardHealth snapshot={snapshot.systemHealth} />

      <OperationsDashboardExports
        currentUserId={currentUserId}
        initialLoadFailed={initialExportsLoadFailed}
        initialNextCursor={initialExportsNextCursor}
        initialTasks={initialExports}
        query={view.query}
        timeZone={snapshot.timeZone}
      />

      <OperationsDetailSheet {...detailSheetProps} />
      <p aria-live="polite" className="sr-only" role="status">
        {liveMessage}
      </p>
    </div>
  );
}
