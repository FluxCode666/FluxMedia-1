/**
 * 成功图片数 F2 Hairline Line React SVG。
 *
 * 来源：lieflat-charts basics gallery “Thirty days of sign-ups”。保留逐日 barcode 地板、
 * 发丝折线、每日圆点与峰值标数；图片值使用产物数而非任务数。
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

type ImageHairlineLineProps = {
  buckets: readonly DataDashboardBucket[];
  accessibleTitle: string;
  titleId: string;
  descriptionId: string;
  tooltipValues: readonly string[];
};

/** 渲染每个自然日一个真实位置的 F2 图片发丝折线及逐点浮窗。 */
export function ImageHairlineLine({
  buckets,
  accessibleTitle,
  titleId,
  descriptionId,
  tooltipValues,
}: ImageHairlineLineProps) {
  const [tooltip, setTooltip] = useState<ChartTooltipDatum | null>(null);
  const geometry = buildHairlineGeometry(
    buckets.map((bucket) => bucket.imageCount)
  );
  const path = geometry.points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join(" ");
  const labelIndices = new Set(selectDateLabelIndices(buckets.length));
  const peak = geometry.points[geometry.peakIndex];
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
            data-image-day={point.index}
            key={buckets[point.index]?.date}
            style={{ animationDelay: `${point.index * 12}ms` }}
            stroke="var(--chart-faint)"
            strokeWidth="0.7"
            x1={point.x}
            x2={point.x}
            y1={geometry.baseline}
            y2={geometry.baseline - 8}
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
        {geometry.points.map((point) => (
          <circle
            className="lieflat-pop"
            cx={point.x}
            cy={point.y}
            fill="var(--chart-ink)"
            key={buckets[point.index]?.date}
            r={
              point.index === geometry.peakIndex && point.value > 0 ? 4.2 : 2.2
            }
            style={{ animationDelay: `${160 + point.index * 12}ms` }}
          >
            <title>{`${buckets[point.index]?.date}: ${point.value}`}</title>
          </circle>
        ))}
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
                data-chart-tooltip-target="images"
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
        {peak && peak.value > 0 ? (
          <text
            fill="var(--chart-ink)"
            fontSize="10"
            fontWeight="800"
            textAnchor="middle"
            x={peak.x}
            y={Math.max(14, peak.y - 11)}
          >
            {peak.value}
          </text>
        ) : null}
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
          ONE DOT = ONE ACCOUNT-TIME-ZONE DAY
        </text>
      </svg>
      <ChartHoverTooltip datum={tooltip} />
    </div>
  );
}
