/**
 * 用户端成功图片逐日折线图。
 *
 * 使用方：DataDashboardCharts。折线直接表达日期趋势，数据点和浮窗均由 shadcn Chart
 * 与 Recharts 提供，不包含管理端的装饰性 Lieflat 图元。
 */
"use client";

import type { DataDashboardBucket } from "@repo/shared/analytics/contracts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/ui/components/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  formatDashboardAxisNumber,
  formatDashboardDateTick,
} from "./chart-format";
import { DashboardChartCard } from "./dashboard-chart-card";

type ImageLineChartProps = {
  buckets: readonly DataDashboardBucket[];
  locale: string;
  title: string;
  description: string;
  summary: string;
};

/** 渲染每天成功图片数量的常规折线图。 */
export function ImageLineChart({
  buckets,
  locale,
  title,
  description,
  summary,
}: ImageLineChartProps) {
  const config = {
    imageCount: {
      label: title,
      color: "var(--chart-1)",
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
        data-dashboard-chart="images-line"
        role="img"
      >
        <LineChart
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
            allowDecimals={false}
            axisLine={false}
            tickFormatter={(value) =>
              formatDashboardAxisNumber(Number(value), locale)
            }
            tickLine={false}
            width={42}
          />
          <ChartTooltip
            content={<ChartTooltipContent indicator="line" />}
            cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
          />
          <Line
            activeDot={{ r: 4 }}
            dataKey="imageCount"
            dot={buckets.length <= 14 ? { r: 2.5 } : false}
            isAnimationActive={false}
            stroke="var(--color-imageCount)"
            strokeWidth={2}
            type="monotone"
          />
        </LineChart>
      </ChartContainer>
    </DashboardChartCard>
  );
}
