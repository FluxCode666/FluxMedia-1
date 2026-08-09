/**
 * 视频趋势 L3 Barcode Lollipop React SVG。
 *
 * 来源：lieflat-charts lupi gallery “Ninety days as a barcode”。保留每天贯穿绘图区的
 * barcode 发丝、短 stem、圆点与峰值；数量和秒数由同一快照在父组件本地切换。
 */
import type { DataDashboardBucket } from "@repo/shared/analytics/contracts";

import {
  buildHairlineGeometry,
  selectDateLabelIndices,
} from "./chart-geometry";

type VideoBarcodeLollipopProps = {
  buckets: readonly DataDashboardBucket[];
  values: readonly number[];
  accessibleTitle: string;
  titleId: string;
  descriptionId: string;
};

/** 渲染 1 至 30 天视频标量序列的 L3 barcode lollipop。 */
export function VideoBarcodeLollipop({
  buckets,
  values,
  accessibleTitle,
  titleId,
  descriptionId,
}: VideoBarcodeLollipopProps) {
  const geometry = buildHairlineGeometry(values);
  const peak = geometry.points[geometry.peakIndex];
  const labelIndices = new Set(selectDateLabelIndices(buckets.length));
  return (
    <svg
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="block h-auto max-h-[300px] w-full"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      viewBox="0 0 400 260"
    >
      <title>{accessibleTitle}</title>
      {geometry.points.map((point) => (
        <line
          className="lieflat-fade"
          data-video-day={point.index}
          key={buckets[point.index]?.date}
          style={{ animationDelay: `${point.index * 8}ms` }}
          stroke="var(--chart-grid)"
          strokeWidth="0.7"
          x1={point.x}
          x2={point.x}
          y1={geometry.plotTop}
          y2={geometry.baseline + 4}
        />
      ))}
      {geometry.points.map((point) => {
        const stemEnd = Math.min(
          geometry.baseline,
          point.y + 12 + ((point.index * 17) % 23)
        );
        return (
          <g
            className="lieflat-fade"
            key={buckets[point.index]?.date}
            style={{ animationDelay: `${160 + point.index * 8}ms` }}
          >
            <line
              stroke="var(--chart-ink)"
              strokeWidth="1.1"
              x1={point.x}
              x2={point.x}
              y1={point.y}
              y2={stemEnd}
            />
            <circle
              className="lieflat-pop"
              cx={point.x}
              cy={point.y}
              fill="var(--chart-ink)"
              r={
                point.index === geometry.peakIndex && point.value > 0
                  ? 4.6
                  : 2.7
              }
            >
              <title>{`${buckets[point.index]?.date}: ${point.value}`}</title>
            </circle>
          </g>
        );
      })}
      {peak && peak.value > 0 ? (
        <text
          fill="var(--chart-ink)"
          fontSize="10"
          fontWeight="800"
          textAnchor="middle"
          x={peak.x}
          y={Math.max(14, peak.y - 10)}
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
            y={geometry.baseline + 22}
          >
            {buckets[point.index]?.date.slice(5)}
          </text>
        ) : null
      )}
    </svg>
  );
}
