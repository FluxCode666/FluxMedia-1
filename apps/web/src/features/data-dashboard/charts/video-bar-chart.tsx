/**
 * 用户端与管理端成功视频逐日柱状图。
 *
 * 使用方：DataDashboardCharts。查看者可在视频数量和成功视频秒数之间切换；切换只替换
 * 当前快照的展示序列，不重新请求数据或改变日期范围。
 */
"use client";

import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/ui/components/chart";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  formatDashboardAxisNumber,
  formatDashboardDateTick,
} from "./chart-format";
import { DashboardChartCard } from "./dashboard-chart-card";
import type { DashboardTranslationNamespace } from "./data-dashboard-charts";

export type VideoDashboardMode = "count" | "seconds";

/** 从同一快照选择视频数量或秒数序列，不修改其它图表。 */
export function selectVideoDashboardSeries(
  snapshot: DataDashboardOutput,
  mode: VideoDashboardMode
): number[] {
  return snapshot.buckets.map((bucket) =>
    mode === "count" ? bucket.videoCount : bucket.videoSeconds
  );
}

type VideoBarChartProps = {
  snapshot: DataDashboardOutput;
  namespace?: DashboardTranslationNamespace;
};

/** 渲染可切换统计口径的每日成功视频柱状图。 */
export function VideoBarChart({
  namespace = "DataDashboard",
  snapshot,
}: VideoBarChartProps) {
  const locale = useLocale();
  const t = useTranslations(namespace);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const [mode, setMode] = useState<VideoDashboardMode>("count");
  const values = selectVideoDashboardSeries(snapshot, mode);
  const data = snapshot.buckets.map((bucket, index) => ({
    date: bucket.date,
    value: values[index] ?? 0,
  }));
  const unit = t(`charts.videoMode.${mode}`);
  const range = t("charts.rangeLabel", {
    start: snapshot.range.startDate,
    end: snapshot.range.endDate,
  });
  const config = {
    value: {
      label: unit,
      color: "var(--chart-3)",
    },
  } satisfies ChartConfig;

  /** 只接受当前 Tabs 声明的两个值，忽略未知字符串。 */
  function changeMode(value: string): void {
    if (value === "count" || value === "seconds") setMode(value);
  }

  return (
    <DashboardChartCard
      action={
        <Tabs onValueChange={changeMode} value={mode}>
          <TabsList aria-label={t("charts.videoMode.label")}>
            <TabsTrigger value="count">
              {t("charts.videoMode.count")}
            </TabsTrigger>
            <TabsTrigger value="seconds">
              {t("charts.videoMode.seconds")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      }
      description={t("charts.videosDescription", { range, unit })}
      summary={t("charts.videosSummary", {
        value: number.format(values.reduce((sum, value) => sum + value, 0)),
        unit,
      })}
      title={t("charts.videos")}
    >
      <ChartContainer
        aria-label={t("charts.videos")}
        className="h-[260px] w-full aspect-auto"
        config={config}
        data-dashboard-chart={`videos-bar-${mode}`}
        role="img"
      >
        <BarChart
          accessibilityLayer
          data={data}
          margin={{ left: 0, right: 12, top: 8 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="date"
            minTickGap={18}
            tickFormatter={formatDashboardDateTick}
            tickLine={false}
            tickMargin={10}
          />
          <YAxis
            allowDecimals={mode === "seconds"}
            axisLine={false}
            tickFormatter={(value) =>
              formatDashboardAxisNumber(Number(value), locale)
            }
            tickLine={false}
            width={42}
          />
          <ChartTooltip
            content={<ChartTooltipContent hideIndicator />}
            cursor={{ fill: "var(--muted)" }}
          />
          <Bar
            dataKey="value"
            fill="var(--color-value)"
            isAnimationActive={false}
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
    </DashboardChartCard>
  );
}
