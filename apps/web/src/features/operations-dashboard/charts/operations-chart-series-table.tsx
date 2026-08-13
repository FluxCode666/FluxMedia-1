/**
 * 运营时间序列的完整等价表格组合器。
 *
 * 使用方：增长、生图、视频和净积分图。组件把共享桶转换为一致的日期、状态与
 * 数值列，调用方只需提供文案；完整序列不会经过视觉降采样。
 */
import type { OperationsNumericSeriesBucket } from "@repo/shared/operations-dashboard/series";

import { OperationsChartDataTable } from "./operations-chart-data-table";
import {
  buildOperationsChartPoints,
  formatOperationsChartPointValue,
} from "./operations-chart-utils";

export type OperationsChartSeriesTableProps = {
  series: readonly OperationsNumericSeriesBucket[];
  locale: string;
  caption: string;
  openLabel: string;
  dateLabel: string;
  valueLabel: string;
  statusLabel: string;
  valueStatusLabel: string;
  preEpochLabel: string;
};

/**
 * 渲染一条完整时间序列的日期、状态和值。
 *
 * @param props 完整序列、语言和所有用户可见表格文案。
 * @returns 折叠式原生数据表；pre_epoch 不显示为数值零。
 */
export function OperationsChartSeriesTable({
  caption,
  dateLabel,
  locale,
  openLabel,
  preEpochLabel,
  series,
  statusLabel,
  valueLabel,
  valueStatusLabel,
}: OperationsChartSeriesTableProps) {
  const points = buildOperationsChartPoints(series, locale);
  return (
    <OperationsChartDataTable
      caption={caption}
      columns={[
        {
          key: "date",
          label: dateLabel,
          render: (point) => point.label,
        },
        {
          key: "status",
          label: statusLabel,
          render: (point) =>
            point.status === "value" ? valueStatusLabel : preEpochLabel,
        },
        {
          key: "value",
          label: valueLabel,
          align: "right",
          render: (point) =>
            formatOperationsChartPointValue(point, locale, preEpochLabel),
        },
      ]}
      openLabel={openLabel}
      rowKey={(point) => point.key}
      rows={points}
    />
  );
}
