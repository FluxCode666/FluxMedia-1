/**
 * 用户数据看板 Lieflat 图表的客户端懒加载边界。
 *
 * 使用方：DataDashboardPanel。四张手写 SVG 形成独立客户端 chunk；等高骨架维持报告
 * 网格空间，Server Component 不直接引入交互视频切换运行时。
 */
"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";

import type { DataDashboardCharts } from "./data-dashboard-charts";

/** 渲染懒加载期间等高且对读屏可见的四图骨架。 */
function DataDashboardChartsLoading() {
  const t = useTranslations("DataDashboard");
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <p className="sr-only">{t("charts.preparing")}</p>
      {["images", "credits", "videos", "composition"].map((key) => (
        <div
          className="h-[390px] animate-pulse rounded-xl border bg-muted/20 motion-reduce:animate-none"
          key={key}
        />
      ))}
    </div>
  );
}

const LazyDataDashboardCharts = dynamic(
  () =>
    import("./data-dashboard-charts").then((module) => ({
      default: module.DataDashboardCharts,
    })),
  {
    ssr: false,
    loading: DataDashboardChartsLoading,
  }
);

/** 懒加载同一快照的四张 Lieflat 图表。 */
export function DataDashboardChartsLazy(
  props: ComponentProps<typeof DataDashboardCharts>
) {
  return <LazyDataDashboardCharts {...props} />;
}
