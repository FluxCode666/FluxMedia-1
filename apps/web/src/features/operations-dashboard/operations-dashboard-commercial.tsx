/**
 * 运营总览商业化摘要。
 *
 * 使用方：OperationsDashboardPanel。组件展示按币种分开的已履约充值收入、两种付费
 * 转化以及按 fulfilled_at/币种核对的订单入口；阶段图由 lieflat-charts 子组件注入。
 */
"use client";

import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { formatPaymentAmount } from "@/features/payment/payment-display-format";
import type { OperationsCommercialSnapshot } from "./commercial-service";
import {
  formatOperationsRate,
  formatPercentagePointChange,
} from "./operations-dashboard-format";
import { OperationsMetricCard } from "./operations-dashboard-metric-card";
import type { OperationsDetailSelection } from "./operations-detail-sheet-data";

type OperationsDashboardCommercialProps = {
  snapshot: OperationsCommercialSnapshot;
  lifecycleChart: ReactNode;
  onOpenDetail: (selection: OperationsDetailSelection) => void;
};

/** 将付费转化比较格式化为百分点；零分母或上线前保持不可比较。 */
function formatConversionComparison(
  comparison: OperationsCommercialSnapshot["conversion"]["fromCreation"]["comparison"],
  locale: string,
  unavailable: string
): string {
  return comparison.status === "value"
    ? formatPercentagePointChange(comparison.changePercentagePoints, locale)
    : unavailable;
}

/** 渲染收入和转化摘要，并保留商业化阶段图的布局位置。 */
export function OperationsDashboardCommercial({
  snapshot,
  lifecycleChart,
  onOpenDetail,
}: OperationsDashboardCommercialProps) {
  const locale = useLocale();
  const t = useTranslations("OperationsDashboard");
  const unavailable = t("status.not_comparable");
  /** 打开以 fulfilled_at 为业务时间的已履约订单，可选绑定收入币种。 */
  const openFulfilledOrders = (currency?: string): void =>
    onOpenDetail({
      module: "commercialization",
      detail: "fulfilled_orders",
      ...(currency ? { currency } : {}),
    });
  const renderConversion = (
    key: "fromCreation" | "fromLogin",
    descriptionKey: "fromCreation" | "fromLogin"
  ) => {
    const metric = snapshot.conversion[key];
    const status = metric.status === "pre_epoch" ? "pre_epoch" : "value";
    return (
      <OperationsMetricCard
        action={
          <Button
            onClick={() => openFulfilledOrders()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("actions.reconcileOrders")}
          </Button>
        }
        comparison={formatConversionComparison(
          metric.comparison,
          locale,
          unavailable
        )}
        description={t(`commercial.conversion.${descriptionKey}.description`)}
        status={metric.current.rate === null ? "not_comparable" : status}
        statusLabel={
          metric.status === "pre_epoch"
            ? t("status.pre_epoch")
            : metric.current.rate === null
              ? unavailable
              : undefined
        }
        title={t(`commercial.conversion.${descriptionKey}.title`)}
        value={
          metric.current.rate === null
            ? unavailable
            : formatOperationsRate(metric.current.rate, locale)
        }
      />
    );
  };
  const revenueComparisons = new Map<
    string,
    OperationsCommercialSnapshot["revenue"]["comparison"][number]
  >();
  for (const comparison of snapshot.revenue.comparison) {
    if (!revenueComparisons.has(comparison.currency)) {
      revenueComparisons.set(comparison.currency, comparison);
    }
  }

  return (
    <section
      aria-labelledby="operations-commercial-title"
      className="space-y-4"
    >
      <div>
        <h2
          className="font-serif text-2xl font-medium tracking-tight"
          id="operations-commercial-title"
        >
          {t("commercial.title")}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {t("commercial.description")}
        </p>
      </div>

      {lifecycleChart}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>{t("commercial.revenue.title")}</CardTitle>
            <CardDescription>
              {t("commercial.revenue.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {snapshot.revenue.status === "pre_epoch" ? (
              <p className="font-mono text-2xl font-extrabold tabular-nums">
                {t("status.pre_epoch")}
              </p>
            ) : snapshot.revenue.current.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("commercial.revenue.empty")}
              </p>
            ) : (
              <dl className="space-y-3">
                {snapshot.revenue.current.map((amount) => {
                  const comparison = revenueComparisons.get(amount.currency);
                  return (
                    <div
                      className="flex items-baseline justify-between gap-4 border-b pb-3 last:border-0 last:pb-0"
                      key={amount.currency}
                    >
                      <dt className="text-sm font-semibold">
                        {amount.currency}
                      </dt>
                      <dd className="text-right">
                        <p className="font-mono text-xl font-extrabold tabular-nums">
                          {formatPaymentAmount(
                            amount.amountMinor,
                            amount.currency,
                            locale
                          )}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {comparison?.status === "value"
                            ? `${comparison.changePercent > 0 ? "+" : ""}${comparison.changePercent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`
                            : unavailable}
                        </p>
                        <Button
                          className="mt-2"
                          onClick={() => openFulfilledOrders(amount.currency)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          {t("actions.reconcileOrders")}
                        </Button>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
              <span>{t("commercial.revenue.disclaimer")}</span>
              <Button
                onClick={() => openFulfilledOrders()}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("actions.reconcileOrders")}
              </Button>
            </div>
          </CardContent>
        </Card>
        {renderConversion("fromCreation", "fromCreation")}
        {renderConversion("fromLogin", "fromLogin")}
      </div>
    </section>
  );
}
