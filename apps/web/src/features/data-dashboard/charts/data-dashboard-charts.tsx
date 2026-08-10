/**
 * 用户数据看板四张常规 shadcn/ui 图表组合。
 *
 * 使用方：DataDashboardChartsLazy。组件把同一快照映射为图片折线图、积分柱状图、
 * 视频可切换柱状图和任务构成环形图，面向普通用户优先使用熟悉的视觉语法。
 */
"use client";

import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { useLocale, useTranslations } from "next-intl";

import { CreditsBarChart } from "./credits-bar-chart";
import { ImageLineChart } from "./image-line-chart";
import { TaskCompositionDonut } from "./task-composition-donut";
import { VideoBarChart } from "./video-bar-chart";

export {
  selectVideoDashboardSeries,
  type VideoDashboardMode,
} from "./video-bar-chart";

type DataDashboardChartsProps = {
  snapshot: DataDashboardOutput;
};

/** 渲染同一日期快照的四张用户端常规图表。 */
export function DataDashboardCharts({ snapshot }: DataDashboardChartsProps) {
  const locale = useLocale();
  const t = useTranslations("DataDashboard");
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const range = t("charts.rangeLabel", {
    start: snapshot.range.startDate,
    end: snapshot.range.endDate,
  });

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ImageLineChart
        buckets={snapshot.buckets}
        description={t("charts.imagesDescription", { range })}
        locale={locale}
        summary={t("charts.imagesSummary", {
          value: number.format(snapshot.metrics.imageCount),
        })}
        title={t("charts.images")}
      />
      <CreditsBarChart
        buckets={snapshot.buckets}
        description={t("charts.creditsDescription", { range })}
        locale={locale}
        summary={t("charts.creditsSummary", {
          value: number.format(snapshot.metrics.creditsConsumed),
        })}
        title={t("charts.credits")}
      />
      <VideoBarChart snapshot={snapshot} />
      <TaskCompositionDonut snapshot={snapshot} />
    </div>
  );
}
