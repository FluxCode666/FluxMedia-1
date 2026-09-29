/**
 * 控制台模型占比图表的懒加载入口。
 *
 * Recharts 只形成一个客户端异步块；等高骨架避免首次加载时页面跳动，Server
 * Component 不会直接引入图表运行时。
 */
import dynamic from "@repo/shared/platform/dynamic";
import type { ComponentProps } from "react";

import type { ModelUsageDistributionChart } from "./dashboard-analytics-charts";

const LazyModelUsageDistributionChart = dynamic(
  () =>
    import("./dashboard-analytics-charts").then((module) => ({
      default: module.ModelUsageDistributionChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="h-[390px] animate-pulse rounded-lg border bg-muted/25" />
    ),
  }
);

/**
 * 懒加载近 24 小时模型使用占比图。
 *
 * @param props 模型分布和界面语言。
 * @returns 客户端动态图表或等高加载骨架。
 */
export function ModelUsageDistributionChartLazy(
  props: ComponentProps<typeof ModelUsageDistributionChart>
) {
  return <LazyModelUsageDistributionChart {...props} />;
}
