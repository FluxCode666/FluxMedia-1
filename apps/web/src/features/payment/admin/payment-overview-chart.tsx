/**
 * 支付概览自然日收入与充值订单折线图。
 *
 * 使用方：payment-overview-chart-lazy。收入按完成日和币种绘制在左轴，全部状态充值
 * 订单按创建日绘制在右轴；完整文字图例与隐藏数据表确保信息不只依赖颜色表达。
 */
"use client";

import { amountMinorToMajor } from "@repo/shared/credits/top-up";
import type { AdminPaymentOverviewOutput } from "@repo/shared/payment/admin-contract";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  formatCompactNumber,
  formatPaymentAmount,
} from "./admin-payment-format";

const REVENUE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;
const ORDER_COLOR = "var(--foreground)";

type PaymentOverviewChartProps = {
  overview: AdminPaymentOverviewOutput;
};

/** 观察图表容器宽度，避免 Recharts 首次渲染得到零宽。 */
function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (nextWidth: number) =>
      setWidth(Math.max(0, Math.floor(nextWidth)));
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

/** 渲染连续自然日的多币种收入线与全部充值订单数量线。 */
export function PaymentOverviewChart({ overview }: PaymentOverviewChartProps) {
  const locale = useLocale();
  const t = useTranslations("AdminPayments.overview");
  const { ref, width } = useElementWidth();
  const currencies = overview.revenueTotals.map((item) => item.currency);
  const orderLabel = t("rechargeOrders");
  const data = overview.daily.map((point) => {
    const row: Record<string, string | number> = {
      date: point.date,
      orderCount: point.orderCount,
    };
    for (const revenue of point.revenue) {
      row[`revenue_${revenue.currency}`] = amountMinorToMajor(
        revenue.amountMinor,
        revenue.currency
      );
    }
    return row;
  });

  return (
    <div className="space-y-4">
      <div className="h-[360px] min-w-0 overflow-hidden" ref={ref}>
        {width > 0 ? (
          <LineChart
            data={data}
            height={360}
            margin={{ bottom: 8, left: 0, right: 4, top: 12 }}
            width={width}
          >
            <CartesianGrid
              stroke="var(--border)"
              strokeDasharray="3 3"
              strokeOpacity={0.45}
              vertical={false}
            />
            <XAxis
              axisLine={false}
              dataKey="date"
              minTickGap={18}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickFormatter={(value) => String(value).slice(8)}
              tickLine={false}
            />
            <YAxis
              axisLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickFormatter={(value) =>
                formatCompactNumber(Number(value), locale)
              }
              tickLine={false}
              width={48}
              yAxisId="revenue"
            />
            <YAxis
              allowDecimals={false}
              axisLine={false}
              orientation="right"
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickLine={false}
              width={36}
              yAxisId="orders"
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "var(--shadow-menu)",
                fontSize: 12,
              }}
              cursor={{
                stroke: "var(--muted-foreground)",
                strokeDasharray: "3 3",
                strokeOpacity: 0.45,
              }}
              formatter={(value, name) => {
                const label = String(name);
                if (label === orderLabel) {
                  return [Number(value).toLocaleString(locale), orderLabel];
                }
                return [
                  new Intl.NumberFormat(locale, {
                    style: "currency",
                    currency: label,
                    maximumFractionDigits: 3,
                  }).format(Number(value)),
                  label,
                ];
              }}
              labelFormatter={(value) => String(value)}
            />
            {currencies.map((currency, index) => (
              <Line
                activeDot={{ r: 4 }}
                dataKey={`revenue_${currency}`}
                dot={false}
                isAnimationActive={false}
                key={currency}
                name={currency}
                stroke={REVENUE_COLORS[index % REVENUE_COLORS.length]}
                strokeWidth={2}
                type="monotone"
                yAxisId="revenue"
              />
            ))}
            <Line
              activeDot={{ r: 4 }}
              dataKey="orderCount"
              dot={false}
              isAnimationActive={false}
              name={orderLabel}
              stroke={ORDER_COLOR}
              strokeDasharray="5 4"
              strokeWidth={1.8}
              type="monotone"
              yAxisId="orders"
            />
          </LineChart>
        ) : (
          <div className="h-full animate-pulse rounded-md bg-muted/30" />
        )}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
        {currencies.map((currency, index) => (
          <span className="inline-flex items-center gap-2" key={currency}>
            <span
              aria-hidden="true"
              className="h-0.5 w-5 rounded-full"
              style={{
                backgroundColor: REVENUE_COLORS[index % REVENUE_COLORS.length],
              }}
            />
            {t("revenueCurrency", { currency })}
          </span>
        ))}
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="w-5 border-foreground border-t border-dashed"
          />
          {orderLabel}
        </span>
      </div>

      <table className="sr-only">
        <caption>{t("accessibleTableCaption")}</caption>
        <thead>
          <tr>
            <th>{t("date")}</th>
            {currencies.map((currency) => (
              <th key={currency}>{t("revenueCurrency", { currency })}</th>
            ))}
            <th>{orderLabel}</th>
          </tr>
        </thead>
        <tbody>
          {overview.daily.map((point) => (
            <tr key={point.date}>
              <td>{point.date}</td>
              {point.revenue.map((revenue) => (
                <td key={revenue.currency}>
                  {formatPaymentAmount(
                    revenue.amountMinor,
                    revenue.currency,
                    locale
                  )}
                </td>
              ))}
              <td>{point.orderCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
