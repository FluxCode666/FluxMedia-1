/**
 * 积分净用量 F3 Hairline Area React SVG。
 *
 * 来源：lieflat-charts basics gallery “Concurrent users, filled with days”。保留一天一根
 * 从基线到峰值的发丝、细轮廓与峰值标数；面积表示当日净积分而非累计余额。
 */
"use client";

import type { DataDashboardBucket } from "@repo/shared/analytics/contracts";
import { useState } from "react";

import {
  buildHairlineGeometry,
  selectDateLabelIndices,
} from "./chart-geometry";
import {
  ChartHoverTooltip,
  type ChartTooltipDatum,
} from "./chart-hover-tooltip";

type CreditsHairlineAreaProps = {
  buckets: readonly DataDashboardBucket[];
  accessibleTitle: string;
  titleId: string;
  descriptionId: string;
  tooltipValues: readonly string[];
};

/** 渲染逐日非负净积分的 F3 发丝面积及逐日浮窗。 */
export function CreditsHairlineArea({
  buckets,
  accessibleTitle,
  titleId,
  descriptionId,
  tooltipValues,
}: CreditsHairlineAreaProps) {
  const [tooltip, setTooltip] = useState<ChartTooltipDatum | null>(null);
  const geometry = buildHairlineGeometry(
    buckets.map((bucket) => bucket.creditsConsumed)
  );
  const path = geometry.points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join(" ");
  const peak = geometry.points[geometry.peakIndex];
  const labelIndices = new Set(selectDateLabelIndices(buckets.length));
  return (
    <div className="relative">
      <svg
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className="block h-auto max-h-[300px] w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        viewBox="0 0 400 260"
      >
        <title>{accessibleTitle}</title>
        <line
          stroke="var(--chart-grid)"
          strokeWidth="0.8"
          x1="22"
          x2="378"
          y1={geometry.baseline}
          y2={geometry.baseline}
        />
        {geometry.points.map((point) => (
          <line
            className="lieflat-fade"
            data-credit-day={point.index}
            key={buckets[point.index]?.date}
            opacity={point.index === geometry.peakIndex ? 1 : 0.68}
            style={{ animationDelay: `${point.index * 12}ms` }}
            stroke={
              point.index === geometry.peakIndex
                ? "var(--chart-ink)"
                : "var(--chart-muted)"
            }
            strokeWidth={point.index === geometry.peakIndex ? 1.1 : 0.7}
            x1={point.x}
            x2={point.x}
            y1={geometry.baseline}
            y2={point.y}
          />
        ))}
        <path
          className="lieflat-draw"
          d={path}
          fill="none"
          pathLength="1"
          stroke="var(--chart-ink)"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
        {peak && peak.value > 0 ? (
          <>
            <circle
              className="lieflat-pop"
              cx={peak.x}
              cy={peak.y}
              fill="var(--chart-ink)"
              r="4.2"
            />
            <text
              fill="var(--chart-ink)"
              fontSize="10"
              fontWeight="800"
              textAnchor="middle"
              x={peak.x}
              y={Math.max(14, peak.y - 11)}
            >
              {new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(
                peak.value
              )}
            </text>
          </>
        ) : null}
        {geometry.points.map((point) => {
          const bucket = buckets[point.index];
          if (!bucket) return null;
          const datum = {
            x: point.x,
            y: point.y,
            label: bucket.date,
            value: tooltipValues[point.index] ?? String(point.value),
          };
          return (
            <foreignObject
              height="22"
              key={`tooltip-${bucket.date}`}
              width="22"
              x={point.x - 11}
              y={point.y - 11}
            >
              <button
                aria-label={`${datum.label}: ${datum.value}`}
                className="h-full w-full rounded-full border-0 bg-transparent p-0 outline-none focus-visible:ring-1 focus-visible:ring-[var(--chart-ink)]"
                data-chart-tooltip-target="credits"
                onBlur={() => setTooltip(null)}
                onFocus={() => setTooltip(datum)}
                onPointerDown={() => setTooltip(datum)}
                onPointerEnter={() => setTooltip(datum)}
                onPointerLeave={() => setTooltip(null)}
                type="button"
              />
            </foreignObject>
          );
        })}
        {geometry.points.map((point) =>
          labelIndices.has(point.index) ? (
            <text
              fill="var(--chart-muted)"
              fontSize="7.5"
              fontWeight="600"
              key={buckets[point.index]?.date}
              letterSpacing="0.08em"
              textAnchor="middle"
              x={point.x}
              y={geometry.baseline + 20}
            >
              {buckets[point.index]?.date.slice(5)}
            </text>
          ) : null
        )}
        <text
          fill="var(--chart-faint)"
          fontSize="7"
          fontWeight="600"
          letterSpacing="0.12em"
          textAnchor="middle"
          x="200"
          y="252"
        >
          ONE HAIRLINE = ONE DAY OF NET CREDITS
        </text>
      </svg>
      <ChartHoverTooltip datum={tooltip} />
    </div>
  );
}
