/**
 * 运营看板生图数量趋势。
 *
 * 使用方：OperationsDashboardPanel。图形沿用 Lieflat Basics F3 Hairline
 * Area：每个可见桶从地板竖起一根发丝，顶边轮廓串联峰值；pre_epoch 留空，
 * 完整桶由键盘导航和等价表格提供。
 */
"use client";

import type { OperationsNumericSeriesBucket } from "@repo/shared/operations-dashboard/series";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/ui/components/chart";
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
  OPERATIONS_CHART_MID_GRAY,
} from "./operations-chart-utils";

export type OperationsImageChartLabels = {
  title: string;
  description: string;
  source: string;
  series: string;
  navigation: string;
  tableOpen: string;
  tableCaption: string;
  date: string;
  status: string;
  valueStatus: string;
  value: string;
  preEpoch: string;
};

export type OperationsImageChartProps = {
  locale: string;
  series: readonly OperationsNumericSeriesBucket[];
  labels: OperationsImageChartLabels;
  onSelectPoint?: (bucket: OperationsNumericSeriesBucket) => void;
};

/**
 * 渲染 F3 生图发丝面积趋势。
 *
 * @param props 完整生图序列、语言和用户可见文案。
 * @returns 发丝面积图、tooltip、完整键盘点与完整等价表。
 */
export function OperationsImageChart({
  labels,
  locale,
  onSelectPoint,
  series,
}: OperationsImageChartProps) {
  const fullPoints = buildOperationsChartPoints(series, locale);
  const visualPoints = buildOperationsVisualPoints(series, locale);
  const config = {
    value: { label: labels.series, color: OPERATIONS_CHART_INK },
  } satisfies ChartConfig;
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
      description={labels.description}
      source={labels.source}
      title={labels.title}
    >
      <ChartContainer
        aria-label={labels.title}
        className="h-72 w-full aspect-auto"
        config={config}
        role="img"
      >
        <ComposedChart
          accessibilityLayer
          barCategoryGap="42%"
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
                hideIndicator
                labelFormatter={formatOperationsTooltipLabel}
              />
            }
            cursor={{ fill: "#CFCEC7" }}
          />
          <Bar
            dataKey="value"
            fill={OPERATIONS_CHART_MID_GRAY}
            isAnimationActive="auto"
            maxBarSize={1.2}
            minPointSize={0}
            radius={0}
          />
          <Line
            activeDot={{ fill: OPERATIONS_CHART_INK, r: 4.2 }}
            connectNulls={false}
            dataKey="value"
            dot={false}
            isAnimationActive="auto"
            stroke="var(--color-value)"
            strokeWidth={1.2}
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
        seriesLabel={labels.series}
      />
    </OperationsChartCard>
  );
}
