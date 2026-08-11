/**
 * 用户端与管理端数据看板的四张常规 shadcn/ui 图表组合。
 *
 * 使用方：DataDashboardChartsLazy。组件把同一快照映射为图片折线图、积分柱状图、
 * 视频可切换柱状图和任务构成环形图；通过 namespace 切换本人或全站文案。
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
  namespace?: DashboardTranslationNamespace;
};

export type DashboardTranslationNamespace =
  | "DataDashboard"
  | "AdminDataDashboard";

/** 渲染同一日期快照的四张常规图表；标题可切换到管理员文案。 */
export function DataDashboardCharts({
  snapshot,
  namespace = "DataDashboard",
}: DataDashboardChartsProps) {
  const locale = useLocale();
  const t = useTranslations(namespace);
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
      <VideoBarChart namespace={namespace} snapshot={snapshot} />
      <TaskCompositionDonut namespace={namespace} snapshot={snapshot} />
    </div>
  );
}
