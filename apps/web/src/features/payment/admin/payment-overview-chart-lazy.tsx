"use client";

/**
 * 支付概览 Recharts 懒加载入口。
 *
 * 使用方：支付概览 Server Component。图表运行时形成独立客户端块，等高骨架避免
 * 软导航期间布局跳动。
 */
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

import type { PaymentOverviewChart } from "./payment-overview-chart";

const LazyPaymentOverviewChart = dynamic(
  () =>
    import("./payment-overview-chart").then((module) => ({
      default: module.PaymentOverviewChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="h-[404px] animate-pulse rounded-md bg-muted/25" />
    ),
  }
);

/** 渲染异步支付趋势图表。 */
export function PaymentOverviewChartLazy(
  props: ComponentProps<typeof PaymentOverviewChart>
) {
  return <LazyPaymentOverviewChart {...props} />;
}
