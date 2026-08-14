/**
 * 运营看板图表的 Mono 令牌、完整桶转换与视觉降采样工具。
 *
 * 使用方：本目录所有 Lieflat 图表。工具只改变可见几何的点数，不改变完整
 * 数据表、键盘导航或服务端事实；上线前桶始终保留为空缺状态。
 */
import type { OperationsNumericSeriesBucket } from "@repo/shared/operations-dashboard/series";
import { downsampleOperationsSeries } from "@repo/shared/operations-dashboard/series";

import {
  formatOperationsDate,
  formatOperationsDateTick,
  formatOperationsNumber,
} from "../operations-dashboard-format";

export const OPERATIONS_CHART_INK = "#1C1C1A";
export const OPERATIONS_CHART_DARK_GRAY = "#55554F";
export const OPERATIONS_CHART_MID_GRAY = "#8F8E88";
export const OPERATIONS_CHART_LIGHT_GRAY = "#B0AFA9";
export const OPERATIONS_CHART_GRID = "#CFCEC7";
export const OPERATIONS_CHART_SILENT = "#D8D6CE";
export const OPERATIONS_CHART_MAX_POINTS = 90;

/** 可被 Recharts 消费的单序列桶，同时保留原始桶索引。 */
export type OperationsChartPoint = {
  index: number;
  key: string;
  label: string;
  shortLabel: string;
  status: OperationsNumericSeriesBucket["status"];
  value: number | null;
};

/**
 * 把完整服务端桶转成图表点。
 *
 * @param series 完整、按时间升序的服务端序列。
 * @param locale 日期与数字的显示语言。
 * @returns 与输入等长的图表点；pre_epoch 的 value 为 null。
 */
export function buildOperationsChartPoints(
  series: readonly OperationsNumericSeriesBucket[],
  locale: string
): OperationsChartPoint[] {
  return series.map((point, index) => ({
    index,
    key: point.key,
    label: formatOperationsDate(point.from, locale),
    shortLabel: formatOperationsDateTick(point.from),
    status: point.status,
    value: point.status === "value" ? point.value : null,
  }));
}

/**
 * 为固定宽度图表选择确定性可见点。
 *
 * @param series 完整服务端序列。
 * @param locale 日期显示语言。
 * @param maxPoints 可见点上限，默认 90。
 * @returns 首末、极值和等距代表点；index 仍指向完整原序列。
 * @throws RangeError 当共享降采样器收到非法参数。
 */
export function buildOperationsVisualPoints(
  series: readonly OperationsNumericSeriesBucket[],
  locale: string,
  maxPoints = OPERATIONS_CHART_MAX_POINTS
): OperationsChartPoint[] {
  if (series.length === 0) return [];
  return downsampleOperationsSeries(series, maxPoints).map(
    ({ index, point }) => ({
      index,
      key: point.key,
      label: formatOperationsDate(point.from, locale),
      shortLabel: formatOperationsDateTick(point.from),
      status: point.status,
      value: point.status === "value" ? point.value : null,
    })
  );
}

/** 从 Recharts payload 读取服务端生成的完整日期标签。 */
export function formatOperationsTooltipLabel(
  _value: unknown,
  payload: readonly { payload?: unknown }[]
): string {
  const point = payload[0]?.payload as { label?: unknown } | null | undefined;
  return String(point?.label ?? "");
}

/**
 * 格式化单个趋势点的值或特殊状态。
 *
 * @param point 完整桶转换后的点。
 * @param locale 数字显示语言。
 * @param preEpochLabel 上线前状态文案。
 * @returns 可直接用于 tooltip、键盘按钮和表格的文本。
 */
export function formatOperationsChartPointValue(
  point: Pick<OperationsChartPoint, "status" | "value">,
  locale: string,
  preEpochLabel: string
): string {
  if (point.status === "pre_epoch" || point.value === null) {
    return preEpochLabel;
  }
  return formatOperationsNumber(point.value, locale);
}
