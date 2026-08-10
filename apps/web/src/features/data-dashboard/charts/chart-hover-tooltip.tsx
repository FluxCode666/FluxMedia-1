/**
 * 数据看板图表的统一 hover 浮窗。
 *
 * 使用方：F2、F3、L3 与 G4 自定义 React SVG。浮窗只展示命中图形背后的真实日期
 * 或任务分类数据；定位使用同一 400×260 viewBox 坐标，不读取鼠标屏幕坐标。
 */
import type { CSSProperties } from "react";

/** 一个已命中的真实图表数据点及其 SVG 锚点。 */
export type ChartTooltipDatum = {
  x: number;
  y: number;
  label: string;
  value: string;
};

type ChartHoverTooltipProps = {
  datum: ChartTooltipDatum | null;
};

/**
 * 将 SVG 锚点转换为卡片内百分比定位并渲染纯白 Mono 浮窗。
 *
 * @param props 当前命中的数据点；null 时不渲染。
 * @returns 不拦截指针事件的可读浮窗。
 */
export function ChartHoverTooltip({ datum }: ChartHoverTooltipProps) {
  if (!datum) return null;

  const left = Math.min(94, Math.max(6, (datum.x / 400) * 100));
  const top = Math.min(92, Math.max(8, (datum.y / 260) * 100));
  const horizontal = datum.x < 80 ? "0" : datum.x > 320 ? "-100%" : "-50%";
  const vertical = datum.y < 64 ? "12px" : "calc(-100% - 12px)";
  const style: CSSProperties = {
    left: `${left}%`,
    top: `${top}%`,
    transform: `translate(${horizontal}, ${vertical})`,
  };

  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute z-10 min-w-28 rounded-lg border border-black/15 bg-[var(--chart-paper)] px-3 py-2 text-xs text-[var(--chart-ink)]"
      data-chart-tooltip="true"
      role="tooltip"
      style={style}
    >
      <p className="font-medium text-[var(--chart-muted)]">{datum.label}</p>
      <p className="mt-0.5 font-bold tabular-nums">{datum.value}</p>
    </div>
  );
}
