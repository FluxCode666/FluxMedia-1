/**
 * 运营趋势完整数据点的键盘与触摸导航。
 *
 * 使用方：所有时间序列图。可见图形允许视觉降采样，但此控件逐桶保留完整
 * 真实数据；聚焦或触摸按钮会更新相邻的状态说明，确保非鼠标用户可读。
 */
"use client";

import { cn } from "@repo/ui/utils";
import { useId, useState } from "react";

import type { OperationsChartPoint } from "./operations-chart-utils";
import { formatOperationsChartPointValue } from "./operations-chart-utils";

export type OperationsChartKeyboardPointsProps = {
  points: readonly OperationsChartPoint[];
  locale: string;
  seriesLabel: string;
  navigationLabel: string;
  preEpochLabel: string;
  unitLabel?: string;
};

/**
 * 渲染完整桶的紧凑焦点队列。
 *
 * @param props 完整点、语言、系列/导航/状态文案和可选单位。
 * @returns 可横向滚动的按钮序列与 aria-live 当前值。
 * @sideEffects 仅在本地记录最后聚焦或触摸的数据点。
 */
export function OperationsChartKeyboardPoints({
  locale,
  navigationLabel,
  points,
  preEpochLabel,
  seriesLabel,
  unitLabel,
}: OperationsChartKeyboardPointsProps) {
  const navigationId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const activePoint = points[activeIndex];
  const activeValue = activePoint
    ? formatOperationsChartPointValue(activePoint, locale, preEpochLabel)
    : preEpochLabel;

  return (
    <div className="grid gap-2">
      <p className="sr-only" id={navigationId}>
        {navigationLabel}
      </p>
      <ul
        aria-labelledby={navigationId}
        className="flex max-w-full gap-1 overflow-x-auto pb-1"
      >
        {points.map((point, index) => {
          const value = formatOperationsChartPointValue(
            point,
            locale,
            preEpochLabel
          );
          return (
            <li className="flex items-end" key={point.key}>
              <button
                aria-label={`${point.label}，${seriesLabel}：${value}${
                  unitLabel ? ` ${unitLabel}` : ""
                }`}
                className={cn(
                  "h-5 min-w-2 rounded-full bg-[#B0AFA9] outline-none",
                  "transition-[height,background-color]",
                  "hover:h-7 hover:bg-[#55554F]",
                  "focus-visible:h-7 focus-visible:bg-[#1C1C1A]",
                  point.status === "pre_epoch" && "bg-[#D8D6CE]"
                )}
                onClick={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                type="button"
              />
            </li>
          );
        })}
      </ul>
      <p aria-live="polite" className="text-xs font-medium text-[#55554F]">
        {activePoint
          ? `${activePoint.label} · ${seriesLabel} · ${activeValue}${
              unitLabel ? ` ${unitLabel}` : ""
            }`
          : navigationLabel}
      </p>
    </div>
  );
}
