/**
 * 用户端与管理端成功任务构成环形图。
 *
 * 使用方：DataDashboardCharts。环形图只比较图片任务和视频任务两类成功任务，旁边的
 * 文本明细同时给出任务数和占比，避免颜色成为唯一信息来源。
 */
"use client";

import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/ui/components/chart";
import { useLocale, useTranslations } from "next-intl";
import { Cell, Pie, PieChart } from "recharts";

import { DashboardChartCard } from "./dashboard-chart-card";
import type { DashboardTranslationNamespace } from "./data-dashboard-charts";

type TaskCompositionDonutProps = {
  snapshot: DataDashboardOutput;
  namespace?: DashboardTranslationNamespace;
};

type TaskCompositionItem = {
  kind: "image" | "video";
  value: number;
  fill: string;
};

/** 渲染图片和视频成功任务的数量与占比。 */
export function TaskCompositionDonut({
  namespace = "DataDashboard",
  snapshot,
}: TaskCompositionDonutProps) {
  const locale = useLocale();
  const t = useTranslations(namespace);
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const range = t("charts.rangeLabel", {
    start: snapshot.range.startDate,
    end: snapshot.range.endDate,
  });
  const total = snapshot.taskComposition.totalTasks;
  const data: TaskCompositionItem[] = [
    {
      kind: "image",
      value: snapshot.taskComposition.imageTaskCount,
      fill: "var(--color-image)",
    },
    {
      kind: "video",
      value: snapshot.taskComposition.videoCount,
      fill: "var(--color-video)",
    },
  ];
  const config = {
    image: {
      label: t("charts.taskType.image"),
      color: "var(--chart-1)",
    },
    video: {
      label: t("charts.taskType.video"),
      color: "var(--chart-4)",
    },
  } satisfies ChartConfig;

  return (
    <DashboardChartCard
      description={t("charts.compositionDescription", { range })}
      summary={
        total === 0
          ? t("charts.compositionEmpty")
          : t("charts.compositionSummary", {
              images: number.format(snapshot.taskComposition.imageTaskCount),
              videos: number.format(snapshot.taskComposition.videoCount),
            })
      }
      title={t("charts.composition")}
    >
      {total === 0 ? (
        <div className="flex h-[260px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-6 text-center text-sm text-muted-foreground">
          {t("charts.compositionEmpty")}
        </div>
      ) : (
        <div className="grid items-center gap-4 sm:grid-cols-[minmax(220px,1fr)_minmax(150px,.7fr)]">
          <div className="relative">
            <ChartContainer
              aria-label={t("charts.composition")}
              className="mx-auto h-[260px] w-full max-w-[360px] aspect-auto"
              config={config}
              data-dashboard-chart="composition-donut"
              role="img"
            >
              <PieChart accessibilityLayer>
                <ChartTooltip
                  content={<ChartTooltipContent hideLabel nameKey="kind" />}
                />
                <Pie
                  data={data}
                  dataKey="value"
                  innerRadius={62}
                  isAnimationActive={false}
                  nameKey="kind"
                  outerRadius={92}
                  paddingAngle={2}
                  stroke="var(--card)"
                  strokeWidth={2}
                >
                  {data.map((item) => (
                    <Cell fill={item.fill} key={item.kind} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="font-serif text-2xl font-medium tabular-nums">
                {number.format(total)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t("charts.totalTasks")}
              </span>
            </div>
          </div>
          <div className="space-y-4">
            {data.map((item) => {
              const itemConfig = config[item.kind];
              return (
                <div className="space-y-1" key={item.kind}>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span
                        aria-hidden="true"
                        className="size-2.5 rounded-sm"
                        style={{ backgroundColor: item.fill }}
                      />
                      {itemConfig.label}
                    </span>
                    <span className="font-medium tabular-nums">
                      {percent.format(item.value / total)}
                    </span>
                  </div>
                  <p className="pl-4 text-xs text-muted-foreground">
                    {t("charts.taskCount", {
                      value: number.format(item.value),
                    })}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </DashboardChartCard>
  );
}
