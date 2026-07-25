"use client";

/**
 * 控制台近 24 小时模型使用占比图表。
 *
 * 本文件是首页唯一直接依赖 Recharts 的模块，由懒加载包装器拆包；右侧文本列表提供
 * 完整模型、任务数和比例，确保颜色不是理解分布的唯一方式。
 */
import { formatAdobeModelIdForDisplay } from "@repo/shared/adobe";
import type { ModelUsageDistribution } from "@repo/shared/analytics/contracts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { useEffect, useRef, useState } from "react";
import { Cell, Pie, PieChart, Tooltip } from "recharts";

type ModelUsageDistributionChartProps = {
  distribution: ModelUsageDistribution;
  isZh: boolean;
};

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/**
 * 观察容器宽度，避免 PieChart 首次测量为零。
 *
 * @returns 图表容器 ref 与向下取整后的非负宽度。
 */
function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (value: number) => setWidth(Math.max(0, Math.floor(value)));
    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/**
 * 渲染近 24 小时成功任务使用的模型比例。
 *
 * @param props 已按任务数降序的模型分布与界面语言。
 * @returns 自适应环形图、可滚动明细列表及空状态。
 */
export function ModelUsageDistributionChart({
  distribution,
  isZh,
}: ModelUsageDistributionChartProps) {
  const { ref, width } = useElementWidth();
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const data = distribution.models.map((item, index) => ({
    name:
      item.model === "unknown"
        ? copy("Unknown model", "未知模型")
        : formatAdobeModelIdForDisplay(item.model),
    value: item.taskCount,
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));

  return (
    <Card className="h-full overflow-hidden">
      <CardHeader className="border-b pb-5">
        <CardTitle className="font-serif text-lg font-medium tracking-tight">
          {copy("Model usage", "模型使用占比")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {copy("Successful tasks in the last 24 hours", "近24小时成功任务")}
        </p>
      </CardHeader>
      <CardContent className="grid min-h-[286px] items-center gap-2 py-5 sm:grid-cols-[minmax(210px,1fr)_minmax(170px,.8fr)]">
        <div
          aria-label={copy(
            `Model usage chart with ${distribution.totalTasks} tasks`,
            `模型使用占比图，共 ${distribution.totalTasks} 个任务`
          )}
          className="relative h-[230px] min-w-0"
          ref={ref}
          role="img"
        >
          {distribution.totalTasks === 0 ? (
            <div className="absolute inset-0 m-auto flex size-44 items-center justify-center rounded-full border bg-muted/20 px-8 text-center text-xs text-muted-foreground">
              {copy("No model usage yet", "近24小时暂无模型使用记录")}
            </div>
          ) : width > 0 ? (
            <>
              <PieChart height={230} width={width}>
                <Pie
                  cx="50%"
                  cy="50%"
                  data={data}
                  dataKey="value"
                  innerRadius={54}
                  isAnimationActive={false}
                  nameKey="name"
                  outerRadius={92}
                  stroke="var(--card)"
                  strokeWidth={2}
                >
                  {data.map((entry) => (
                    <Cell fill={entry.color} key={entry.name} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: "var(--shadow-menu)",
                    fontSize: 12,
                  }}
                  formatter={(value) => [
                    Number(value).toLocaleString(),
                    copy("Tasks", "任务数"),
                  ]}
                />
              </PieChart>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="font-serif text-2xl font-medium tabular-nums">
                  {distribution.totalTasks.toLocaleString()}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {copy("tasks", "个任务")}
                </span>
              </div>
            </>
          ) : (
            <div className="h-full animate-pulse rounded-full bg-muted/35" />
          )}
        </div>
        <div className="max-h-[250px] space-y-4 overflow-y-auto pr-1">
          {data.map((item) => {
            const percentage =
              distribution.totalTasks > 0
                ? (item.value / distribution.totalTasks) * 100
                : 0;
            return (
              <div className="space-y-1.5" key={item.name}>
                <div className="flex items-start justify-between gap-4 text-xs">
                  <span className="flex min-w-0 items-start gap-2 text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="mt-1 size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="break-all" title={item.name}>
                      {item.name}
                    </span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {percentage.toFixed(1)}%
                  </span>
                </div>
                <p className="pl-4 text-[11px] text-muted-foreground">
                  {item.value.toLocaleString()} {copy("tasks", "个任务")}
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
