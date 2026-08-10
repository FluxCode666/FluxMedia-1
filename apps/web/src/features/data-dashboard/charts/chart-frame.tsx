/**
 * Lieflat React SVG 的统一卡片、标题、摘要与 Mono scope 框架。
 *
 * 使用方：F2、F3、L3、G4。页面主题只影响外层 chrome；图表内部固定使用审计过的
 * paper/ink/gray token，并在 reduced-motion 下关闭入场动画；具体图表自行处理数据交互。
 */
"use client";

import { Card } from "@repo/ui/components/card";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { LIEFLAT_CHART_MOTION_CSS, LIEFLAT_MONO_TOKENS } from "./chart-tokens";

type ChartFrameProps = {
  template: string;
  title: string;
  description: string;
  summary: string;
  source: string;
  replayLabel: string;
  controls?: ReactNode;
  children: (ids: { titleId: string; descriptionId: string }) => ReactNode;
};

type ChartScopeStyle = CSSProperties & {
  "--chart-ink": string;
  "--chart-paper": string;
  "--chart-muted": string;
  "--chart-faint": string;
  "--chart-grid": string;
};

const chartScopeStyle: ChartScopeStyle = {
  "--chart-ink": LIEFLAT_MONO_TOKENS.ink,
  "--chart-paper": LIEFLAT_MONO_TOKENS.paper,
  "--chart-muted": LIEFLAT_MONO_TOKENS.muted,
  "--chart-faint": LIEFLAT_MONO_TOKENS.faint,
  "--chart-grid": LIEFLAT_MONO_TOKENS.grid,
  backgroundColor: LIEFLAT_MONO_TOKENS.paper,
  color: LIEFLAT_MONO_TOKENS.ink,
};

/**
 * 渲染一个可访问且模板可追溯的 Lieflat 图表卡。
 *
 * @param props 模板 ID、结论式标题、持续摘要、SVG 和可选控件。
 * @returns 固定 Mono 局部作用域，不依赖远程字体或 CDN。
 */
export function ChartFrame({
  template,
  title,
  description,
  summary,
  source,
  replayLabel,
  controls,
  children,
}: ChartFrameProps) {
  const id = useId().replaceAll(":", "");
  const titleId = `chart-title-${id}`;
  const descriptionId = `chart-description-${id}`;
  const revealRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [renderKey, setRenderKey] = useState(0);

  useEffect(() => {
    const element = revealRef.current;
    if (!element) return;
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      typeof IntersectionObserver === "undefined"
    ) {
      setIsRevealed(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setIsRevealed(true);
        observer.disconnect();
      },
      { threshold: 0.15 }
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  /** 重新挂载 SVG 并用两帧切换确保已完成的 CSS 动画可以再次播放。 */
  function replayAnimation(): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    setIsRevealed(false);
    setRenderKey((current) => current + 1);
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = requestAnimationFrame(() => {
        setIsRevealed(true);
        animationFrameRef.current = null;
      });
    });
  }

  return (
    <Card
      className="overflow-hidden border-black/10"
      data-lieflat-template={template}
      style={chartScopeStyle}
    >
      <style>{LIEFLAT_CHART_MOTION_CSS}</style>
      <div
        className="lieflat-reveal"
        data-revealed={isRevealed}
        ref={revealRef}
      >
        <figure aria-labelledby={titleId} aria-describedby={descriptionId}>
          <figcaption className="flex flex-col gap-3 px-5 pb-2 pt-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3
                className="text-[16.5px] font-bold tracking-[-0.02em]"
                id={titleId}
              >
                {title}
              </h3>
              <p
                className="mt-1 text-[11.5px] text-[var(--chart-muted)]"
                id={descriptionId}
              >
                {description}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {controls}
              <button
                className="rounded-full border border-black/15 px-3 py-1.5 text-xs font-medium text-[var(--chart-muted)] hover:text-[var(--chart-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50"
                onClick={replayAnimation}
                type="button"
              >
                {replayLabel}
              </button>
            </div>
          </figcaption>
          <div className="px-3 py-1" key={renderKey}>
            {children({ titleId, descriptionId })}
          </div>
          <p className="px-5 pb-2 text-xs text-[var(--chart-muted)]">
            {summary}
          </p>
          <p className="px-5 pb-4 text-[9.5px] font-medium uppercase tracking-[0.08em] text-[var(--chart-faint)]">
            {source}
          </p>
        </figure>
      </div>
    </Card>
  );
}
