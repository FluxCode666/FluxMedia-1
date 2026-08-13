/**
 * 运营总览系统健康只读摘要。
 *
 * 使用方：OperationsDashboardPanel。区间成功率、耗时和支付履约失败使用全局日期
 * 筛选；队列与后端成员显式标记为当前值，并只链接既有管理页面。
 */
"use client";

import { Button } from "@repo/ui/components/button";
import { useLocale, useTranslations } from "next-intl";

import { Link } from "@/i18n/routing";

import type { OperationsSystemHealthSnapshot } from "./health-adapter";
import {
  formatCountComparison,
  formatOperationsNumber,
  formatOperationsRate,
  formatPercentagePointChange,
} from "./operations-dashboard-format";
import { OperationsMetricCard } from "./operations-dashboard-metric-card";

type OperationsDashboardHealthProps = {
  snapshot: OperationsSystemHealthSnapshot;
};

/** 将处理秒数压缩为本地化的平均值与 P95 双值。 */
function formatDuration(
  value: OperationsSystemHealthSnapshot["processingDuration"]["current"],
  locale: string,
  unavailable: string
): string {
  if (value.status !== "value") return unavailable;
  return `${formatOperationsNumber(value.averageSeconds, locale)}s / ${formatOperationsNumber(value.p95Seconds, locale)}s`;
}

/** 渲染系统健康摘要和三个既有管理页入口，不提供 CSV 或处置操作。 */
export function OperationsDashboardHealth({
  snapshot,
}: OperationsDashboardHealthProps) {
  const locale = useLocale();
  const t = useTranslations("OperationsDashboard");
  const unavailable = t("status.not_comparable");
  const success = snapshot.taskSuccessRate.current;
  const duration = snapshot.processingDuration.current;
  const failure = snapshot.fulfillmentFailures;
  const backend = snapshot.backendHealth;

  return (
    <section aria-labelledby="operations-health-title" className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2
            className="font-serif text-2xl font-medium tracking-tight"
            id="operations-health-title"
          >
            {t("health.title")}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("health.description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/admin/status">
              {t("health.links.status")}
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/admin/analytics">
              {t("health.links.analytics")}
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/admin/payments/orders">
              {t("health.links.orders")}
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <OperationsMetricCard
          comparison={
            snapshot.taskSuccessRate.comparison.status === "value"
              ? formatPercentagePointChange(
                  snapshot.taskSuccessRate.comparison.changePercentagePoints,
                  locale
                )
              : unavailable
          }
          description={t("health.successRate.description")}
          status={success.status}
          statusLabel={
            success.status === "value"
              ? undefined
              : t(`status.${success.status}`)
          }
          title={t("health.successRate.title")}
          value={
            success.status === "value"
              ? formatOperationsRate(success.rate, locale)
              : t(`status.${success.status}`)
          }
        />
        <OperationsMetricCard
          description={t("health.duration.description")}
          status={duration.status}
          statusLabel={
            duration.status === "value"
              ? undefined
              : t(`status.${duration.status}`)
          }
          title={t("health.duration.title")}
          value={formatDuration(
            duration,
            locale,
            t(`status.${duration.status}`)
          )}
        />
        <OperationsMetricCard
          comparison={formatCountComparison(
            failure.comparison,
            locale,
            unavailable
          )}
          description={t("health.fulfillmentFailures.description")}
          status={failure.status}
          statusLabel={
            failure.status === "pre_epoch" ? t("status.pre_epoch") : undefined
          }
          title={t("health.fulfillmentFailures.title")}
          value={
            failure.status === "pre_epoch"
              ? t("status.pre_epoch")
              : formatOperationsNumber(failure.current.total, locale)
          }
        />
        <OperationsMetricCard
          description={t("health.queue.description")}
          status="current"
          statusLabel={t("status.current")}
          title={t("health.queue.title")}
          value={formatOperationsNumber(snapshot.queueBacklog.total, locale)}
        />
        <OperationsMetricCard
          comparison={t("health.backend.breakdown", {
            degraded: backend.degraded,
            unhealthy: backend.unhealthy,
          })}
          description={t("health.backend.description")}
          status="current"
          statusLabel={t("status.current")}
          title={t("health.backend.title")}
          value={`${formatOperationsNumber(backend.healthy, locale)} / ${formatOperationsNumber(backend.total, locale)}`}
        />
      </div>
    </section>
  );
}
