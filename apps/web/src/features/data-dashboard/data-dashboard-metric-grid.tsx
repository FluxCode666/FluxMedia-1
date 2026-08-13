/**
 * 用户端与管理端数据看板六项范围指标及持续可达的数据口径说明。
 *
 * 使用方：DataDashboardPanel、AdminDataDashboardPanel。所有数值来自同一快照；组件
 * 只格式化并按 namespace 切换本人或管理员所选范围文案，不重新计算统计口径。
 */
"use client";

import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { formatCredits } from "@repo/shared/credits/format";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/components/dialog";
import {
  CalendarCheck2,
  CircleGauge,
  Coins,
  Cpu,
  Film,
  Image,
  Info,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

type DataDashboardMetricGridProps = {
  snapshot: DataDashboardOutput;
  namespace?: "DataDashboard" | "AdminDataDashboard";
};

/** 将可空成功率格式化为用户可区分的百分比或无数据。 */
function formatSuccessRate(
  rate: number | null,
  locale: string,
  unavailableLabel: string
): string {
  if (rate === null) return unavailableLabel;
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: rate === 0 || rate === 1 ? 0 : 1,
    maximumFractionDigits: 1,
  }).format(rate);
}

/**
 * 渲染固定顺序的六项指标与键盘/触摸可达口径说明。
 *
 * @param props 同一日期范围的已验证整页快照。
 * @returns 响应式两至六列指标卡网格。
 */
export function DataDashboardMetricGrid({
  snapshot,
  namespace = "DataDashboard",
}: DataDashboardMetricGridProps) {
  const locale = useLocale();
  const t = useTranslations(namespace);
  const number = new Intl.NumberFormat(locale);
  const metrics = [
    {
      key: "images",
      label: t("metrics.images"),
      value: number.format(snapshot.metrics.imageCount),
      icon: Image,
    },
    {
      key: "videoSeconds",
      label: t("metrics.videoSeconds"),
      value: t("metrics.secondsValue", {
        value: number.format(snapshot.metrics.videoSeconds),
      }),
      icon: Film,
    },
    {
      key: "credits",
      label: t("metrics.credits"),
      value: formatCredits(snapshot.metrics.creditsConsumed),
      icon: Coins,
    },
    {
      key: "successRate",
      label: t("metrics.successRate"),
      value: formatSuccessRate(
        snapshot.metrics.successRate.rate,
        locale,
        t("metrics.noData")
      ),
      icon: CircleGauge,
    },
    {
      key: "activeDays",
      label: t("metrics.activeDays"),
      value: number.format(snapshot.metrics.activeDays),
      icon: CalendarCheck2,
    },
    {
      key: "mostUsedModel",
      label: t("metrics.mostUsedModel"),
      value: snapshot.metrics.mostUsedModel?.model ?? t("metrics.noData"),
      icon: Cpu,
    },
  ] as const;

  return (
    <section
      aria-labelledby="data-dashboard-metrics-title"
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          className="font-serif text-lg font-medium tracking-tight"
          id="data-dashboard-metrics-title"
        >
          {t("metrics.title")}
        </h2>
        <Dialog>
          <DialogTrigger asChild>
            <Button size="sm" type="button" variant="ghost">
              <Info />
              {t("methodology.trigger")}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{t("methodology.title")}</DialogTitle>
              <DialogDescription>
                {t("methodology.description")}
              </DialogDescription>
            </DialogHeader>
            <dl className="space-y-4 text-sm">
              {[
                "images",
                "videoSeconds",
                "credits",
                "successRate",
                "activeDays",
                "mostUsedModel",
              ].map((key) => (
                <div key={key}>
                  <dt className="font-medium">{t(`metrics.${key}`)}</dt>
                  <dd className="mt-1 text-muted-foreground">
                    {t(`methodology.items.${key}`)}
                  </dd>
                </div>
              ))}
            </dl>
          </DialogContent>
        </Dialog>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <Card key={metric.key}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                  {metric.label}
                </CardTitle>
                <Icon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                  strokeWidth={1.5}
                />
              </CardHeader>
              <CardContent>
                <p className="break-words font-serif text-2xl font-medium tracking-tight tabular-nums sm:text-3xl">
                  {metric.value}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
