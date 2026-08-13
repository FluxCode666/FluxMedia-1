/**
 * 运营看板成功业务净积分趋势。
 *
 * 使用方：OperationsDashboardPanel。采用 Lieflat Glance G12 Stagger Wave，
 * 因为净积分允许正负且长跨度时密度高；F2/F3 的连续轮廓会弱化零线两侧的
 * 方向语义，而运营 dashboard 需要三秒快读，所以以逐桶正负波形诚实编码。
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
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { formatOperationsNumber } from "../operations-dashboard-format";
import { OperationsChartCard } from "./operations-chart-card";
import { OperationsChartKeyboardPoints } from "./operations-chart-keyboard-points";
import { OperationsChartSeriesTable } from "./operations-chart-series-table";
import {
  buildOperationsChartPoints,
  buildOperationsVisualPoints,
  OPERATIONS_CHART_DARK_GRAY,
  OPERATIONS_CHART_GRID,
  OPERATIONS_CHART_INK,
  OPERATIONS_CHART_MID_GRAY,
} from "./operations-chart-utils";

export type OperationsNetCreditsChartLabels = {
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

export type OperationsNetCreditsChartProps = {
  locale: string;
  series: readonly OperationsNumericSeriesBucket[];
  labels: OperationsNetCreditsChartLabels;
};

/**
 * 返回以零为中心的对称轴范围。
 *
 * @param values 可见图表点值，可包含空值。
 * @returns 对称的负正上界；全零时使用 -1 到 1 避免退化。
 */
function getSymmetricDomain(
  values: readonly (number | null)[]
): [number, number] {
  const maximum = Math.max(1, ...values.map((value) => Math.abs(value ?? 0)));
  return [-maximum, maximum];
}

/**
 * 渲染 G12 正负净积分波形。
 *
 * @param props 完整净积分序列、语言和用户可见文案。
 * @returns 零线居中的 stagger bar、tooltip、完整键盘点与完整表格。
 */
export function OperationsNetCreditsChart({
  labels,
  locale,
  series,
}: OperationsNetCreditsChartProps) {
  const fullPoints = buildOperationsChartPoints(series, locale);
  const visualPoints = buildOperationsVisualPoints(series, locale);
  const domain = getSymmetricDomain(visualPoints.map((point) => point.value));
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
        <BarChart
          accessibilityLayer
          barCategoryGap="26%"
          data={visualPoints}
          margin={{ bottom: 4, left: 0, right: 12, top: 12 }}
        >
          <CartesianGrid
            stroke={OPERATIONS_CHART_GRID}
            strokeWidth={0.6}
            vertical={false}
          />
          <ReferenceLine stroke={OPERATIONS_CHART_INK} strokeWidth={1} y={0} />
          <XAxis
            axisLine={false}
            dataKey="shortLabel"
            minTickGap={24}
            tick={{ fill: "#8F8E88", fontSize: 9, fontWeight: 600 }}
            tickLine={false}
            tickMargin={10}
          />
          <YAxis
            axisLine={false}
            domain={domain}
            tick={{ fill: "#8F8E88", fontSize: 9, fontWeight: 600 }}
            tickFormatter={(value) =>
              formatOperationsNumber(Number(value), locale)
            }
            tickLine={false}
            width={52}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideIndicator
                labelFormatter={(_, payload) =>
                  String(payload[0]?.payload?.label ?? "")
                }
              />
            }
            cursor={{ fill: OPERATIONS_CHART_GRID }}
          />
          <Bar dataKey="value" isAnimationActive="auto" radius={[3, 3, 3, 3]}>
            {visualPoints.map((point) => (
              <Cell
                fill={
                  point.status === "pre_epoch"
                    ? OPERATIONS_CHART_GRID
                    : (point.value ?? 0) < 0
                      ? OPERATIONS_CHART_MID_GRAY
                      : (point.value ?? 0) === 0
                        ? OPERATIONS_CHART_DARK_GRAY
                        : OPERATIONS_CHART_INK
                }
                key={point.key}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <OperationsChartKeyboardPoints
        locale={locale}
        navigationLabel={labels.navigation}
        points={fullPoints}
        preEpochLabel={labels.preEpoch}
        seriesLabel={labels.series}
      />
    </OperationsChartCard>
  );
}
