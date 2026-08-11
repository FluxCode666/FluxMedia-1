/**
 * 管理端全局数据看板客户端状态机与页面主体。
 *
 * 使用方：`/dashboard/admin/analytics`。日期范围、快照竞态和失败保留行为与用户看板
 * 保持一致，但图表文案切换为管理员口径，数据通过管理员 UOL Action 刷新。
 */
"use client";

import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { Button } from "@repo/ui/components/button";
import { cn } from "@repo/ui/utils";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useRouter } from "@/i18n/routing";

import { refreshAdminDataDashboardAction } from "./admin-actions";
import type { DataDashboardActionResult } from "./actions";
import { buildAdminDataDashboardHref } from "./admin-data-dashboard-query";
import { DataDashboardChartsLazy } from "./charts/data-dashboard-charts-lazy";
import { DataDashboardDateRangePicker } from "./data-dashboard-date-range-picker";
import { DataDashboardMetricGrid } from "./data-dashboard-metric-grid";
import { DataDashboardPending } from "./data-dashboard-pending";
import {
  applyDataDashboardActionResult,
  createDataDashboardRequestGate,
  type DataDashboardFailureStatus,
  type DataDashboardViewState,
} from "./data-dashboard-state";
import {
  type DataDashboardAppliedRange,
  isDefaultDataDashboardRange,
} from "./data-dashboard-query";

type AdminDataDashboardPanelProps = {
  initialSnapshot: DataDashboardOutput | null;
  initialFailureStatus?: DataDashboardFailureStatus;
  invalidDeepLink?: boolean;
};

/** 将快照 asOf 格式化到管理员应用时区。 */
function formatSnapshotTime(snapshot: DataDashboardOutput, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: snapshot.timeZone,
  }).format(new Date(snapshot.asOf));
}

/**
 * 渲染可筛选、刷新并从失败恢复的全站看板。
 *
 * @param props RSC 首屏快照、初始失败和非法深链提示。
 * @returns 管理员指标、全站图表和日期范围交互。
 */
export function AdminDataDashboardPanel({
  initialSnapshot,
  initialFailureStatus = null,
  invalidDeepLink = false,
}: AdminDataDashboardPanelProps) {
  const locale = useLocale();
  const t = useTranslations("AdminDataDashboard");
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
    router.replace("/dashboard/admin/analytics", { scroll: false });
  }, [invalidDeepLink, router]);

  /** 提交自定义范围或刷新已应用范围，并只允许最新请求提交状态。 */
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
      const result = await refreshAdminDataDashboardAction(range);
      actionResult = result?.data ?? { status: "unavailable" as const };
    } catch {
      actionResult = { status: "unavailable" as const };
    }
    if (!requestGate.current.isLatest(requestId)) return;
    setView((current) => applyDataDashboardActionResult(current, actionResult));
    if (actionResult.status === "ready") {
      const nextRange = {
        startDate: actionResult.snapshot.range.startDate,
        endDate: actionResult.snapshot.range.endDate,
      };
      setDraftRange(nextRange);
      const href = buildAdminDataDashboardHref(
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

  /** 手动刷新始终查询已应用范围，不读取未提交草稿。 */
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
            <Button
              onClick={refreshAppliedRange}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("actions.retry")}
            </Button>
          </div>
        ) : null}
      </header>

      <DataDashboardMetricGrid
        namespace="AdminDataDashboard"
        snapshot={snapshot}
      />

      <section
        aria-labelledby="admin-data-dashboard-charts-title"
        className="space-y-3"
      >
        <h2
          className="font-serif text-lg font-medium tracking-tight"
          id="admin-data-dashboard-charts-title"
        >
          {t("charts.title")}
        </h2>
        <DataDashboardChartsLazy
          namespace="AdminDataDashboard"
          snapshot={snapshot}
        />
      </section>
      <p aria-live="polite" className="sr-only">
        {liveMessage}
      </p>
    </div>
  );
}
