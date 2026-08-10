/**
 * 成功任务构成 G4 Dot Waffle React SVG。
 *
 * 来源：lieflat-charts glance gallery “Where sign-ups come from”。每个点表示 1% 而非
 * 一个任务；原始图片/视频任务数持续展示，总任务为零时不生成伪比例点。
 */
"use client";

import { useState } from "react";

import { allocateTaskWaffleDots } from "./chart-geometry";
import {
  ChartHoverTooltip,
  type ChartTooltipDatum,
} from "./chart-hover-tooltip";
import { LIEFLAT_MONO_TOKENS } from "./chart-tokens";

type TaskDotWaffleProps = {
  imageTaskCount: number;
  videoTaskCount: number;
  accessibleTitle: string;
  imageLabel: string;
  videoLabel: string;
  emptyLabel: string;
  titleId: string;
  descriptionId: string;
  imageTooltipValue: string;
  videoTooltipValue: string;
};

/** 渲染两类 100 点 Waffle、原始任务数图例与分类浮窗。 */
export function TaskDotWaffle({
  imageTaskCount,
  videoTaskCount,
  accessibleTitle,
  imageLabel,
  videoLabel,
  emptyLabel,
  titleId,
  descriptionId,
  imageTooltipValue,
  videoTooltipValue,
}: TaskDotWaffleProps) {
  const [tooltip, setTooltip] = useState<ChartTooltipDatum | null>(null);
  const allocation = allocateTaskWaffleDots(imageTaskCount, videoTaskCount);
  const [imagePercent, videoPercent] = allocation.allocations;
  const tooltipByKind = {
    image: {
      x: 230,
      y: 72,
      label: imageLabel,
      value: imageTooltipValue,
    },
    video: {
      x: 230,
      y: 132,
      label: videoLabel,
      value: videoTooltipValue,
    },
  } satisfies Record<"image" | "video", ChartTooltipDatum>;
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
        {allocation.dots.map((dot, index) => {
          const row = Math.floor(index / 10);
          const column = index % 10;
          const datum = {
            ...tooltipByKind[dot.kind],
            x: 18 + column * 17,
            y: 24 + row * 17,
          };
          return (
            <g key={dot.id}>
              <circle
                className="lieflat-pop"
                cx={datum.x}
                cy={datum.y}
                data-waffle-dot={dot.kind}
                fill={
                  dot.kind === "image"
                    ? LIEFLAT_MONO_TOKENS.ink
                    : LIEFLAT_MONO_TOKENS.ladder[3]
                }
                r="6.2"
                style={{ animationDelay: `${index * 8}ms` }}
              />
              <foreignObject
                height="14"
                width="14"
                x={datum.x - 7}
                y={datum.y - 7}
              >
                <button
                  aria-label={`${datum.label}: ${datum.value}`}
                  className="h-full w-full rounded-full border-0 bg-transparent p-0"
                  onBlur={() => setTooltip(null)}
                  onFocus={() => setTooltip(datum)}
                  onPointerDown={() => setTooltip(datum)}
                  onPointerEnter={() => setTooltip(datum)}
                  onPointerLeave={() => setTooltip(null)}
                  tabIndex={-1}
                  type="button"
                />
              </foreignObject>
            </g>
          );
        })}
        {allocation.dots.length === 0 ? (
          <text
            fill="var(--chart-muted)"
            fontSize="12"
            textAnchor="middle"
            x="90"
            y="108"
          >
            {emptyLabel}
          </text>
        ) : null}
        <circle cx="230" cy="72" fill={LIEFLAT_MONO_TOKENS.ink} r="6" />
        <g>
          <text
            fill="var(--chart-ink)"
            fontSize="11"
            fontWeight="600"
            x="244"
            y="68"
          >
            {imageLabel}
          </text>
          <text
            fill="var(--chart-ink)"
            fontSize="16"
            fontWeight="800"
            x="244"
            y="86"
          >
            {imageTaskCount} · {imagePercent}%
          </text>
        </g>
        <foreignObject height="48" width="150" x="220" y="52">
          <button
            aria-label={`${imageLabel}: ${imageTooltipValue}`}
            className="h-full w-full rounded border-0 bg-transparent p-0 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--chart-ink)]"
            data-chart-tooltip-target="composition-image"
            onBlur={() => setTooltip(null)}
            onFocus={() => setTooltip(tooltipByKind.image)}
            onPointerDown={() => setTooltip(tooltipByKind.image)}
            onPointerEnter={() => setTooltip(tooltipByKind.image)}
            onPointerLeave={() => setTooltip(null)}
            type="button"
          />
        </foreignObject>
        <circle cx="230" cy="132" fill={LIEFLAT_MONO_TOKENS.ladder[3]} r="6" />
        <g>
          <text
            fill="var(--chart-ink)"
            fontSize="11"
            fontWeight="600"
            x="244"
            y="128"
          >
            {videoLabel}
          </text>
          <text
            fill="var(--chart-muted)"
            fontSize="16"
            fontWeight="800"
            x="244"
            y="146"
          >
            {videoTaskCount} · {videoPercent}%
          </text>
        </g>
        <foreignObject height="48" width="150" x="220" y="112">
          <button
            aria-label={`${videoLabel}: ${videoTooltipValue}`}
            className="h-full w-full rounded border-0 bg-transparent p-0 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--chart-ink)]"
            data-chart-tooltip-target="composition-video"
            onBlur={() => setTooltip(null)}
            onFocus={() => setTooltip(tooltipByKind.video)}
            onPointerDown={() => setTooltip(tooltipByKind.video)}
            onPointerEnter={() => setTooltip(tooltipByKind.video)}
            onPointerLeave={() => setTooltip(null)}
            type="button"
          />
        </foreignObject>
        <text
          fill="var(--chart-faint)"
          fontSize="7"
          fontWeight="600"
          letterSpacing="0.12em"
          textAnchor="middle"
          x="200"
          y="244"
        >
          ONE DOT = ONE PERCENT OF SUCCESSFUL TASKS
        </text>
      </svg>
      <ChartHoverTooltip datum={tooltip} />
    </div>
  );
}
