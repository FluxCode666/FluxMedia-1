/**
 * 运营看板增长与活跃的小多图趋势。
 *
 * 使用方：OperationsDashboardPanel。图形严格沿用 Lieflat Basics F2
 * Hairline Line 的日历地板、发丝折线和逐点圆点；每条序列独立缩放，避免四种
 * 不同量级互相压扁，同时以完整表格保留可比较事实。
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
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import type { OperationsGrowthSnapshot } from "../growth-service";
import { OperationsChartCard } from "./operations-chart-card";
import { OperationsChartDataTable } from "./operations-chart-data-table";
import { OperationsChartKeyboardPoints } from "./operations-chart-keyboard-points";
import {
  buildOperationsChartPoints,
  buildOperationsVisualPoints,
  formatOperationsChartPointValue,
  OPERATIONS_CHART_GRID,
  OPERATIONS_CHART_INK,
} from "./operations-chart-utils";

type GrowthSeriesKey = keyof OperationsGrowthSnapshot["series"];

export type OperationsGrowthTrendChartLabels = {
  title: string;
  description: string;
  source: string;
  tableOpen: string;
  tableCaption: string;
  date: string;
  status: string;
  valueStatus: string;
  preEpoch: string;
  navigation: string;
  series: Record<GrowthSeriesKey, string>;
};

export type OperationsGrowthTrendChartProps = {
  locale: string;
  series: OperationsGrowthSnapshot["series"];
  labels: OperationsGrowthTrendChartLabels;
};

type GrowthTableRow = {
  index: number;
  key: string;
  label: string;
  values: Record<GrowthSeriesKey, number | null>;
  statuses: Record<GrowthSeriesKey, "pre_epoch" | "value">;
};

const GROWTH_SERIES_KEYS: readonly GrowthSeriesKey[] = [
  "newUsers",
  "loginActiveUsers",
  "creationActiveUsers",
  "paymentActiveUsers",
];

/**
 * 将四条同桶增长趋势合并为完整表格行。
 *
 * @param series 增长领域四条完整序列。
 * @param locale 日期显示语言。
 * @returns 以第一条序列为桶基准的完整行；服务层保证四条序列同桶。
 */
function buildGrowthTableRows(
  series: OperationsGrowthSnapshot["series"],
  locale: string
): GrowthTableRow[] {
  const primary = buildOperationsChartPoints(series.newUsers, locale);
  return primary.map((point, index) => {
    const values = {} as Record<GrowthSeriesKey, number | null>;
    const statuses = {} as Record<GrowthSeriesKey, "pre_epoch" | "value">;
    for (const key of GROWTH_SERIES_KEYS) {
      const bucket = series[key][index];
      values[key] = bucket?.status === "value" ? bucket.value : null;
      statuses[key] = bucket?.status === "value" ? "value" : "pre_epoch";
    }
    return { index, key: point.key, label: point.label, values, statuses };
  });
}

type GrowthMiniChartProps = {
  locale: string;
  label: string;
  navigationLabel: string;
  preEpochLabel: string;
  series: readonly OperationsNumericSeriesBucket[];
};

/**
 * 渲染一条 F2 Hairline Line 小图。
 *
 * @param props 单条完整序列及显示文案。
 * @returns 发丝折线、日历地板、tooltip 与完整键盘点导航。
 */
function GrowthMiniChart({
  label,
  locale,
  navigationLabel,
  preEpochLabel,
  series,
}: GrowthMiniChartProps) {
  const fullPoints = buildOperationsChartPoints(series, locale);
  const visualPoints = buildOperationsVisualPoints(series, locale);
  const config = {
    value: { label, color: OPERATIONS_CHART_INK },
  } satisfies ChartConfig;
  return (
    <section aria-label={label} className="grid min-w-0 gap-2">
      <h3 className="text-xs font-bold tracking-[0.08em] text-[#55554F] uppercase">
        {label}
      </h3>
      <ChartContainer
        aria-label={label}
        className="h-40 w-full aspect-auto"
        config={config}
        role="img"
      >
        <LineChart
          accessibilityLayer
          data={visualPoints}
          margin={{ bottom: 4, left: 0, right: 10, top: 8 }}
        >
          <CartesianGrid
            horizontal={false}
            stroke={OPERATIONS_CHART_GRID}
            strokeWidth={0.6}
          />
          <ReferenceLine stroke={OPERATIONS_CHART_GRID} y={0} />
          <XAxis
            axisLine={false}
            dataKey="shortLabel"
            minTickGap={28}
            tick={{ fill: "#8F8E88", fontSize: 9, fontWeight: 600 }}
            tickLine={{ stroke: OPERATIONS_CHART_GRID, strokeWidth: 0.6 }}
            tickMargin={8}
          />
          <YAxis hide domain={[0, "auto"]} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(_, payload) =>
                  String(payload[0]?.payload?.label ?? "")
                }
              />
            }
            cursor={{ stroke: "#8F8E88", strokeDasharray: "2 3" }}
          />
          <Line
            activeDot={{ fill: OPERATIONS_CHART_INK, r: 4 }}
            connectNulls={false}
            dataKey="value"
            dot={{
              fill: OPERATIONS_CHART_INK,
              r: 2.1,
              stroke: OPERATIONS_CHART_INK,
              strokeWidth: 0.8,
            }}
            isAnimationActive="auto"
            stroke="var(--color-value)"
            strokeWidth={1}
            type="linear"
          />
        </LineChart>
      </ChartContainer>
      <OperationsChartKeyboardPoints
        locale={locale}
        navigationLabel={navigationLabel}
        points={fullPoints}
        preEpochLabel={preEpochLabel}
        seriesLabel={label}
      />
    </section>
  );
}

/**
 * 渲染增长、登录活跃、创作活跃和付费活跃四条 F2 小多图。
 *
 * @param props 增长趋势、语言和所有用户可见文案。
 * @returns 一张 Mono 卡片、四个独立缩放图与一份完整等价表。
 */
export function OperationsGrowthTrendChart({
  labels,
  locale,
  series,
}: OperationsGrowthTrendChartProps) {
  const rows = buildGrowthTableRows(series, locale);
  return (
    <OperationsChartCard
      accessibility={
        <OperationsChartDataTable
          caption={labels.tableCaption}
          columns={[
            {
              key: "date",
              label: labels.date,
              render: (row) => row.label,
            },
            ...GROWTH_SERIES_KEYS.map((key) => ({
              key,
              label: labels.series[key],
              align: "right" as const,
              render: (row: GrowthTableRow) =>
                formatOperationsChartPointValue(
                  {
                    status: row.statuses[key],
                    value: row.values[key],
                  },
                  locale,
                  labels.preEpoch
                ),
            })),
          ]}
          openLabel={labels.tableOpen}
          rowKey={(row) => row.key}
          rows={rows}
        />
      }
      description={labels.description}
      source={labels.source}
      title={labels.title}
    >
      <div className="grid gap-6 md:grid-cols-2">
        {GROWTH_SERIES_KEYS.map((key) => (
          <GrowthMiniChart
            key={key}
            label={labels.series[key]}
            locale={locale}
            navigationLabel={labels.navigation}
            preEpochLabel={labels.preEpoch}
            series={series[key]}
          />
        ))}
      </div>
    </OperationsChartCard>
  );
}
