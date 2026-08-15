/**
 * 运营趋势完整数据点的键盘与触摸导航。
 *
 * 使用方：所有时间序列图。可见图形允许视觉降采样，但此控件逐桶保留完整
 * 真实数据；聚焦或触摸按钮会更新相邻状态说明，真实值点击还可把完整桶交给下钻。
 */
"use client";

import type { OperationsNumericSeriesBucket } from "@repo/shared/operations-dashboard/series";
import { cn } from "@repo/ui/utils";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useId,
  useRef,
  useState,
} from "react";

import type { OperationsChartPoint } from "./operations-chart-utils";
import { formatOperationsChartPointValue } from "./operations-chart-utils";

export type OperationsChartKeyboardPointsProps = {
  points: readonly OperationsChartPoint[];
  locale: string;
  seriesLabel: string;
  navigationLabel: string;
  preEpochLabel: string;
  unitLabel?: string;
  onSelectPoint?: (bucket: OperationsNumericSeriesBucket) => void;
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
  onSelectPoint,
  points,
  preEpochLabel,
  seriesLabel,
  unitLabel,
}: OperationsChartKeyboardPointsProps) {
  const navigationId = useId();
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const activeIndex =
    points.length === 0 ? 0 : Math.min(selectedIndex, points.length - 1);
  const activePoint = points[activeIndex];
  const activeValue = activePoint
    ? formatOperationsChartPointValue(activePoint, locale, preEpochLabel)
    : preEpochLabel;

  /** 聚焦指定真实点，并同步 roving tab stop 与 aria-live 读数。 */
  function focusPoint(index: number): void {
    const button = buttonRefs.current[index];
    if (!button) return;
    setSelectedIndex(index);
    button.focus();
  }

  /** 更新当前读数，并只把有真实统计值的完整服务端桶交给下钻调用方。 */
  function selectPoint(index: number): void {
    setSelectedIndex(index);
    const point = points[index];
    if (point?.status === "value") onSelectPoint?.(point.bucket);
  }

  /** 将方向键、Home 与 End 映射到完整时间序列中的相邻或边界点。 */
  function handleKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number
  ): void {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % points.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + points.length) % points.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = points.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusPoint(nextIndex);
  }

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
                  "transition-[height,background-color] motion-reduce:transition-none",
                  "hover:h-7 hover:bg-[#55554F]",
                  "focus-visible:h-7 focus-visible:bg-[#1C1C1A]",
                  point.status === "pre_epoch" && "bg-[#D8D6CE]"
                )}
                onClick={() => selectPoint(index)}
                onFocus={() => setSelectedIndex(index)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                ref={(button) => {
                  buttonRefs.current[index] = button;
                }}
                tabIndex={index === activeIndex ? 0 : -1}
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
