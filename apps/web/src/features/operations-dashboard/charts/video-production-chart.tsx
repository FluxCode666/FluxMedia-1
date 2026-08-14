/**
 * 运营看板视频数量与视频秒数趋势。
 *
 * 使用方：OperationsDashboardPanel。图形沿用 Lieflat Editorial L3 Barcode
 * Lollipop：每个可见桶保留全高日历发丝、从数值点垂下的 stem 与 lollipop 圆点；
 * Tabs 只切换同一快照口径，不改变范围或重新请求。
 */
"use client";

import type { OperationsNumericSeriesBucket } from "@repo/shared/operations-dashboard/series";
import { Button } from "@repo/ui/components/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/ui/components/chart";
import { useState } from "react";
import {
  Bar,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { OperationsChartCard } from "./operations-chart-card";
import { OperationsChartKeyboardPoints } from "./operations-chart-keyboard-points";
import { OperationsChartSeriesTable } from "./operations-chart-series-table";
import {
  buildOperationsChartPoints,
  buildOperationsVisualPoints,
  formatOperationsTooltipLabel,
  OPERATIONS_CHART_GRID,
  OPERATIONS_CHART_INK,
} from "./operations-chart-utils";

export type OperationsVideoChartMode = "count" | "seconds";

export type OperationsVideoChartLabels = {
  title: string;
  description: string;
  source: string;
  modeLabel: string;
  count: string;
  seconds: string;
  navigation: string;
  tableOpen: string;
  tableCaption: string;
  date: string;
  status: string;
  valueStatus: string;
  value: string;
  preEpoch: string;
};

export type OperationsVideoChartProps = {
  locale: string;
  countSeries: readonly OperationsNumericSeriesBucket[];
  secondsSeries: readonly OperationsNumericSeriesBucket[];
  labels: OperationsVideoChartLabels;
  onSelectPoint?: (bucket: OperationsNumericSeriesBucket) => void;
};

/**
 * 渲染可切换数量与秒数口径的 L3 Barcode Lollipop。
 *
 * @param props 两条同桶完整序列、语言和用户可见文案。
 * @returns 同一张卡片内的切换器、图、完整键盘点与当前口径完整表格。
 * @sideEffects 仅更新本地 mode；不会发起网络请求。
 */
export function OperationsVideoChart({
  countSeries,
  labels,
  locale,
  onSelectPoint,
  secondsSeries,
}: OperationsVideoChartProps) {
  const [mode, setMode] = useState<OperationsVideoChartMode>("count");
  const series = mode === "count" ? countSeries : secondsSeries;
  const seriesLabel = mode === "count" ? labels.count : labels.seconds;
  const fullPoints = buildOperationsChartPoints(series, locale);
  const visualPoints = buildOperationsVisualPoints(series, locale);
  const config = {
    value: { label: seriesLabel, color: OPERATIONS_CHART_INK },
  } satisfies ChartConfig;

  /** 仅接受 Tabs 声明的两个稳定值。 */
  function changeMode(value: string): void {
    if (value === "count" || value === "seconds") setMode(value);
  }

  return (
    <OperationsChartCard
      accessibility={
        <OperationsChartSeriesTable
          caption={labels.tableCaption}
          dateLabel={labels.date}
          locale={locale}
          openLabel={labels.tableOpen}
          preEpochLabel={labels.preEpoch}
          series={series}
          statusLabel={labels.status}
          valueLabel={labels.value}
          valueStatusLabel={labels.valueStatus}
        />
      }
      action={
        <fieldset className="inline-flex items-center gap-1 rounded-lg p-1">
          <legend className="sr-only">{labels.modeLabel}</legend>
          <Button
            aria-pressed={mode === "count"}
            onClick={() => changeMode("count")}
            size="sm"
            type="button"
            variant={mode === "count" ? "secondary" : "ghost"}
          >
            {labels.count}
          </Button>
          <Button
            aria-pressed={mode === "seconds"}
            onClick={() => changeMode("seconds")}
            size="sm"
            type="button"
            variant={mode === "seconds" ? "secondary" : "ghost"}
          >
            {labels.seconds}
          </Button>
        </fieldset>
      }
      description={labels.description}
      source={labels.source}
      title={labels.title}
    >
      <ChartContainer
        aria-label={`${labels.title}，${seriesLabel}`}
        className="h-72 w-full aspect-auto"
        config={config}
        role="img"
      >
        <ComposedChart
          accessibilityLayer
          barCategoryGap="22%"
          data={visualPoints}
          margin={{ bottom: 4, left: 0, right: 12, top: 12 }}
        >
          <ReferenceLine stroke={OPERATIONS_CHART_GRID} y={0} />
          <XAxis
            axisLine={false}
            dataKey="shortLabel"
            minTickGap={24}
            tick={{ fill: "#8F8E88", fontSize: 9, fontWeight: 600 }}
            tickLine={false}
            tickMargin={10}
          />
          <YAxis hide domain={[0, "auto"]} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={formatOperationsTooltipLabel}
              />
            }
            cursor={{ stroke: "#8F8E88", strokeDasharray: "2 3" }}
          />
          <Bar
            background={{ fill: OPERATIONS_CHART_GRID }}
            dataKey="value"
            fill={OPERATIONS_CHART_INK}
            isAnimationActive="auto"
            maxBarSize={1.1}
            minPointSize={0}
            radius={0}
          />
          <Line
            activeDot={{ fill: OPERATIONS_CHART_INK, r: 4.6 }}
            connectNulls={false}
            dataKey="value"
            dot={{
              fill: OPERATIONS_CHART_INK,
              r: 2.7,
              stroke: OPERATIONS_CHART_INK,
              strokeWidth: 1,
            }}
            isAnimationActive="auto"
            stroke="transparent"
            strokeWidth={0}
            type="linear"
          />
        </ComposedChart>
      </ChartContainer>
      <OperationsChartKeyboardPoints
        locale={locale}
        navigationLabel={labels.navigation}
        onSelectPoint={onSelectPoint}
        points={fullPoints}
        preEpochLabel={labels.preEpoch}
        seriesLabel={seriesLabel}
      />
    </OperationsChartCard>
  );
}
