/**
 * 用户端每日净积分消耗柱状图。
 *
 * 使用方：DataDashboardCharts。柱高对应单日净积分，让普通用户直接比较各日用量，
 * 不把积分表现为累计余额或管理端密度图。
 */
"use client";

import type { DataDashboardBucket } from "@repo/shared/analytics/contracts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/ui/components/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  formatDashboardAxisNumber,
  formatDashboardDateTick,
} from "./chart-format";
import { DashboardChartCard } from "./dashboard-chart-card";

type CreditsBarChartProps = {
  buckets: readonly DataDashboardBucket[];
  locale: string;
  title: string;
  description: string;
  summary: string;
};

/** 渲染每天非负净积分消耗的常规柱状图。 */
export function CreditsBarChart({
  buckets,
  locale,
  title,
  description,
  summary,
}: CreditsBarChartProps) {
  const config = {
    creditsConsumed: {
      label: title,
      color: "var(--chart-2)",
    },
  } satisfies ChartConfig;

  return (
    <DashboardChartCard
      description={description}
      summary={summary}
      title={title}
    >
      <ChartContainer
        aria-label={title}
        className="h-[260px] w-full aspect-auto"
        config={config}
        data-dashboard-chart="credits-bar"
        role="img"
      >
        <BarChart
          accessibilityLayer
          data={buckets}
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
            dataKey="creditsConsumed"
            fill="var(--color-creditsConsumed)"
            isAnimationActive={false}
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
    </DashboardChartCard>
  );
}
