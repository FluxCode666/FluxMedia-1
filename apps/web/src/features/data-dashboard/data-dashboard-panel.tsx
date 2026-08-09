/**
 * 用户数据看板的原子快照状态机与页面主体。
 *
 * 使用方：`/dashboard/analytics`。组件区分日期草稿、已应用范围、最近有效快照和请求
 * 状态；只有最新成功请求能同时替换范围、指标、图表 DTO 和 URL。
 */
"use client";

import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { Button } from "@repo/ui/components/button";
import { cn } from "@repo/ui/utils";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Link, useRouter } from "@/i18n/routing";

import {
  type DataDashboardActionResult,
  refreshDataDashboardAction,
} from "./actions";
import { DataDashboardChartsLazy } from "./charts/data-dashboard-charts-lazy";
import { DataDashboardDateRangePicker } from "./data-dashboard-date-range-picker";
import { DataDashboardMetricGrid } from "./data-dashboard-metric-grid";
import { DataDashboardPending } from "./data-dashboard-pending";
import {
  buildDataDashboardHref,
  type DataDashboardAppliedRange,
  isDefaultDataDashboardRange,
} from "./data-dashboard-query";
import {
  applyDataDashboardActionResult,
  createDataDashboardRequestGate,
  type DataDashboardFailureStatus,
  type DataDashboardViewState,
} from "./data-dashboard-state";

type DataDashboardPanelProps = {
  initialSnapshot: DataDashboardOutput | null;
  initialFailureStatus?: DataDashboardFailureStatus;
  invalidDeepLink?: boolean;
};

/** 将快照 asOf 格式化到其账号有效时区，浏览器时区不参与。 */
function formatSnapshotTime(snapshot: DataDashboardOutput, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: snapshot.timeZone,
  }).format(new Date(snapshot.asOf));
}

/**
 * 渲染可筛选、刷新并从失败恢复的数据看板。
 *
 * @param props RSC 首屏快照、初始失败和非法深链提示。
 * @returns 六项指标与 U5 图表插槽；首次失败时保留完整可重试状态。
 */
export function DataDashboardPanel({
  initialSnapshot,
  initialFailureStatus = null,
  invalidDeepLink = false,
}: DataDashboardPanelProps) {
  const locale = useLocale();
  const t = useTranslations("DataDashboard");
  const router = useRouter();
  const initialAppliedRange = initialSnapshot
    ? {
        startDate: initialSnapshot.range.startDate,
        endDate: initialSnapshot.range.endDate,
      }
    : null;
  const [view, setView] = useState<DataDashboardViewState>({
    snapshot: initialSnapshot,
    appliedRange: initialAppliedRange,
    requestStatus: initialSnapshot ? "idle" : "error",
    failureStatus: initialSnapshot
      ? null
      : (initialFailureStatus ?? "unavailable"),
  });
  const [draftRange, setDraftRange] = useState({
    startDate: initialAppliedRange?.startDate ?? "",
    endDate: initialAppliedRange?.endDate ?? "",
  });
  const [liveMessage, setLiveMessage] = useState(
    invalidDeepLink ? t("state.invalidDeepLink") : ""
  );
  const requestGate = useRef(createDataDashboardRequestGate());

  useEffect(() => {
    if (!invalidDeepLink) return;
    router.replace("/dashboard/analytics", { scroll: false });
  }, [invalidDeepLink, router]);

  /** 提交自定义范围或刷新已应用范围，并执行最新请求胜出规则。 */
  async function requestSnapshot(
    range: DataDashboardAppliedRange | Record<string, never>
  ): Promise<void> {
    const requestId = requestGate.current.begin();
    setView((current) => ({
      ...current,
      requestStatus: "loading",
      failureStatus: null,
    }));
    setLiveMessage(t("state.loadingDescription"));
    let actionResult: DataDashboardActionResult;
    try {
      const result = await refreshDataDashboardAction(range);
      actionResult = result?.data ?? { status: "unavailable" };
    } catch {
      actionResult = { status: "unavailable" };
    }
    if (!requestGate.current.isLatest(requestId)) return;
    setView((current) => applyDataDashboardActionResult(current, actionResult));
    if (actionResult.status === "ready") {
      const nextRange = {
        startDate: actionResult.snapshot.range.startDate,
        endDate: actionResult.snapshot.range.endDate,
      };
      setDraftRange(nextRange);
      const href = buildDataDashboardHref(
        isDefaultDataDashboardRange(nextRange, actionResult.snapshot.today)
          ? {}
          : nextRange
      );
      router.replace(href, { scroll: false });
      setLiveMessage(t("state.updated"));
      return;
    }
    setLiveMessage(t(`state.failure.${actionResult.status}`));
  }

  /** 手动刷新始终查询已应用范围，绝不读取未应用或失败草稿。 */
  function refreshAppliedRange(): void {
    void requestSnapshot(view.appliedRange ?? {});
  }

  const isLoading = view.requestStatus === "loading";
  if (!view.snapshot || !view.appliedRange) {
    return (
      <div aria-busy={isLoading} className="space-y-6">
        <header>
          <h1 className="font-serif text-2xl font-medium tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </header>
        <DataDashboardPending
          failureStatus={view.failureStatus}
          isLoading={isLoading}
          onRetry={() => void requestSnapshot({})}
        />
        <p aria-live="polite" className="sr-only">
          {liveMessage}
        </p>
      </div>
    );
  }

  const snapshot = view.snapshot;
  return (
    <div aria-busy={isLoading} className="space-y-8">
      <header className="space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="font-serif text-2xl font-medium tracking-tight">
              {t("title")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("description")}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("snapshotMeta", {
                timeZone: snapshot.timeZone,
                asOf: formatSnapshotTime(snapshot, locale),
              })}
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <DataDashboardDateRangePicker
              appliedRange={view.appliedRange}
              disabled={isLoading}
              draftRange={draftRange}
              isApplying={isLoading}
              onApply={(range) => void requestSnapshot(range)}
              onDraftChange={setDraftRange}
              today={snapshot.today}
            />
            <Button
              aria-label={t("actions.refresh")}
              className="shrink-0"
              disabled={isLoading}
              onClick={refreshAppliedRange}
              type="button"
            >
              <RefreshCw
                className={cn(
                  isLoading && "animate-spin motion-reduce:animate-none"
                )}
              />
              {t("actions.refresh")}
            </Button>
          </div>
        </div>
        {view.requestStatus === "stale" && view.failureStatus ? (
          <div
            className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            role="alert"
          >
            <span className="flex items-center gap-2">
              <TriangleAlert aria-hidden="true" className="size-4" />
              {t(`state.failure.${view.failureStatus}`)}
            </span>
            {view.failureStatus === "unauthenticated" ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/sign-in">{t("actions.signIn")}</Link>
              </Button>
            ) : (
              <Button
                onClick={refreshAppliedRange}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("actions.retry")}
              </Button>
            )}
          </div>
        ) : null}
      </header>

      <DataDashboardMetricGrid snapshot={snapshot} />

      <section
        aria-labelledby="data-dashboard-charts-title"
        className="space-y-3"
      >
        <h2
          className="font-serif text-lg font-medium tracking-tight"
          id="data-dashboard-charts-title"
        >
          {t("charts.title")}
        </h2>
        <DataDashboardChartsLazy snapshot={snapshot} />
      </section>
      <p aria-live="polite" className="sr-only">
        {liveMessage}
      </p>
    </div>
  );
}
