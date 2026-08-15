/**
 * 运营总览注册 Cohort 留存矩阵。
 *
 * 使用方：OperationsDashboardPanel。组件保留所选范围内全部注册日，固定高度纵向
 * 滚动，并将 D1/D7/D30 的真实值、未成熟、上线前和无样本状态显式分开。
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
import { cn } from "@repo/ui/utils";
import { useLocale, useTranslations } from "next-intl";

import type { OperationsGrowthCohort } from "./growth-service";
import {
  formatOperationsDate,
  formatOperationsRate,
} from "./operations-dashboard-format";
import type { OperationsDetailSelection } from "./operations-detail-sheet-data";

type OperationsDashboardCohortProps = {
  cohorts: OperationsGrowthCohort[];
  onOpenDetail: (selection: OperationsDetailSelection) => void;
};

/** 将留存状态转成单元格文案，真实零值仍显示 0%。 */
function formatRetentionCell(
  retention: OperationsGrowthCohort["d1"],
  locale: string,
  labels: { immature: string; preEpoch: string; noData: string }
): string {
  if (retention.status === "value") {
    return formatOperationsRate(retention.rate, locale);
  }
  if (retention.status === "immature") return labels.immature;
  if (retention.status === "pre_epoch") return labels.preEpoch;
  return labels.noData;
}

/**
 * 判断留存单元格是否拥有可核对的成熟事实。
 *
 * @param retention 只需携带稳定特殊状态的留存单元格。
 * @returns 已成熟真实值或无样本状态为 true；上线前和未成熟为 false。
 */
export function canOpenOperationsCohortDetail(retention: {
  status: OperationsGrowthCohort["d1"]["status"];
}): boolean {
  return retention.status !== "pre_epoch" && retention.status !== "immature";
}

/** 渲染可逐 Cohort 下钻的固定高度留存核对表。 */
export function OperationsDashboardCohort({
  cohorts,
  onOpenDetail,
}: OperationsDashboardCohortProps) {
  const t = useTranslations("OperationsDashboard");
  const locale = useLocale();
  const labels = {
    immature: t("status.immature"),
    preEpoch: t("status.pre_epoch"),
    noData: t("status.no_data"),
  };

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>{t("growth.cohort.title")}</CardTitle>
        <CardDescription>{t("growth.cohort.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <section
          aria-label={t("growth.cohort.title")}
          className="max-h-[28rem] overflow-auto rounded-xl border"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 固定高度滚动表须允许 Safari 键盘用户聚焦后滚动。
          tabIndex={0}
        >
          <table className="w-full min-w-[42rem] border-collapse text-sm">
            <caption className="sr-only">
              {t("growth.cohort.description")}
            </caption>
            <thead className="sticky top-0 z-20 bg-background">
              <tr className="border-b">
                <th
                  className="sticky left-0 z-30 bg-background px-4 py-3 text-left text-xs font-semibold"
                  scope="col"
                >
                  {t("growth.cohort.date")}
                </th>
                <th
                  className="px-4 py-3 text-right text-xs font-semibold"
                  scope="col"
                >
                  {t("growth.cohort.size")}
                </th>
                {([1, 7, 30] as const).map((day) => (
                  <th
                    className="px-4 py-3 text-right text-xs font-semibold"
                    key={day}
                    scope="col"
                  >
                    D{day}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.map((cohort) => (
                <tr className="border-b last:border-0" key={cohort.cohortDate}>
                  <th
                    className="sticky left-0 z-10 whitespace-nowrap bg-background px-4 py-3 text-left font-medium"
                    scope="row"
                  >
                    {formatOperationsDate(cohort.cohortDate, locale)}
                  </th>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {cohort.cohortSize.toLocaleString(locale)}
                  </td>
                  {([1, 7, 30] as const).map((day) => {
                    const retention = cohort[`d${day}` as const];
                    return (
                      <td className="px-2 py-2 text-right" key={day}>
                        <Button
                          className={cn(
                            "h-9 min-w-24 justify-end font-mono tabular-nums shadow-none",
                            retention.status !== "value" &&
                              "text-muted-foreground"
                          )}
                          disabled={!canOpenOperationsCohortDetail(retention)}
                          onClick={() =>
                            onOpenDetail({
                              module: "growth",
                              detail: "retention_cohorts",
                              cohortDate: cohort.cohortDate,
                              retentionDay: day,
                            })
                          }
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          {formatRetentionCell(retention, locale, labels)}
                        </Button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </CardContent>
    </Card>
  );
}
