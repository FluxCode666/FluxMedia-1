"use client";

/**
 * 公开 API 文档的响应式滚动电梯。
 *
 * 桌面端固定在内容左侧，窄屏退化为顶栏下方的横向导航；滚动和窗口尺寸变化通过
 * requestAnimationFrame 合帧，避免长文档高频读取布局造成抖动。
 */
import { cn } from "@repo/ui/utils";
import { useEffect, useState } from "react";

import { resolveActiveElevatorSection } from "./api-docs-elevator-core";
import type {
  ApiIntegrationEndpoint,
  ApiIntegrationEndpointGroup,
} from "./api-integration-docs-data";

type ElevatorEndpoint = Pick<
  ApiIntegrationEndpoint,
  "id" | "method" | "path" | "title"
>;
type ElevatorGroup = Pick<
  ApiIntegrationEndpointGroup,
  "endpointIds" | "id" | "title"
>;

const MOBILE_ACTIVATION_LINE = 144;
// 章节使用 scroll-mt-32（128px）；激活线需略低于锚点落位，否则点击电梯后会
// 因章节顶部仍高于激活线而回退高亮上一项。
const DESKTOP_ACTIVATION_LINE = 144;

/**
 * 渲染随滚动高亮的章节导航。
 *
 * @param ariaLabel - 导航区域的无障碍名称。
 * @param description - 目录头部的浏览说明。
 * @param endpoints - 当前公开且按页面顺序排列的端点。
 * @param groups - 按正文顺序排列的端点模块。
 * @returns 响应式 aside；没有端点时不渲染。
 * @sideEffects 监听 window scroll、resize 与 hashchange，并读取章节矩形。
 */
export function ApiDocsElevator({
  ariaLabel,
  description,
  endpoints,
  groups,
}: {
  ariaLabel: string;
  description: string;
  endpoints: readonly ElevatorEndpoint[];
  groups: readonly ElevatorGroup[];
}) {
  const firstSectionId = groups[0]?.id ?? endpoints[0]?.id ?? "";
  const [activeId, setActiveId] = useState(firstSectionId);
  const sectionIdsKey = groups
    .flatMap((group) => [group.id, ...group.endpointIds])
    .join("\n");

  useEffect(() => {
    const sectionIds = sectionIdsKey.split("\n").filter(Boolean);
    if (sectionIds.length === 0) return;

    let frameId: number | null = null;

    /** 在同一动画帧读取所有章节位置并更新一次高亮状态。 */
    const measure = () => {
      frameId = null;
      const sections = sectionIds.flatMap((id) => {
        const element = document.getElementById(id);
        return element
          ? [{ id, top: element.getBoundingClientRect().top }]
          : [];
      });
      const documentHeight = document.documentElement.scrollHeight;
      const isAtPageEnd =
        window.scrollY + window.innerHeight >= documentHeight - 2;
      const activationLine =
        window.innerWidth < 1024
          ? MOBILE_ACTIVATION_LINE
          : DESKTOP_ACTIVATION_LINE;
      const nextActiveId = resolveActiveElevatorSection(
        sections,
        activationLine,
        isAtPageEnd
      );

      if (nextActiveId) {
        setActiveId((currentId) =>
          currentId === nextActiveId ? currentId : nextActiveId
        );
      }
    };

    /** 把多个连续浏览器事件合并为一次布局读取。 */
    const scheduleMeasure = () => {
      if (frameId === null) {
        frameId = window.requestAnimationFrame(measure);
      }
    };

    scheduleMeasure();
    window.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("hashchange", scheduleMeasure);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("hashchange", scheduleMeasure);
    };
  }, [sectionIdsKey]);

  if (endpoints.length === 0) return null;

  return (
    <aside className="sticky top-16 z-20 -mx-4 self-start border-y border-border/60 bg-background/95 px-4 py-2 shadow-whisper backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 lg:top-24 lg:z-10 lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none">
      <nav
        aria-label={ariaLabel}
        className="lg:overflow-hidden lg:rounded-2xl lg:border lg:border-border lg:bg-card lg:shadow-sm"
      >
        <div className="hidden border-b border-border bg-muted/20 px-4 py-4 lg:block">
          <p className="text-sm font-medium text-foreground">{ariaLabel}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="flex w-full max-w-full gap-3 overflow-x-auto lg:block lg:space-y-5 lg:overflow-visible lg:p-3">
          {groups.map((group, groupIndex) => {
            const groupEndpoints = group.endpointIds.flatMap((endpointId) => {
              const endpoint = endpoints.find((item) => item.id === endpointId);
              return endpoint ? [endpoint] : [];
            });
            const isGroupActive =
              activeId === group.id ||
              groupEndpoints.some((endpoint) => endpoint.id === activeId);

            return (
              <div
                className="shrink-0 border-r border-border/60 pr-3 last:border-r-0 last:pr-0 lg:border-r-0 lg:pr-0"
                key={group.id}
              >
                <a
                  aria-current={activeId === group.id ? "location" : undefined}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1 text-left text-[11px] font-medium uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 lg:rounded-md",
                    isGroupActive
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  href={`#${group.id}`}
                  onClick={() => setActiveId(group.id)}
                >
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {String(groupIndex + 1).padStart(2, "0")}
                  </span>
                  <span>{group.title}</span>
                </a>
                <div className="mt-1 flex gap-1 lg:block lg:space-y-0.5">
                  {groupEndpoints.map((endpoint) => {
                    const isActive = activeId === endpoint.id;
                    return (
                      <a
                        aria-current={isActive ? "location" : undefined}
                        className={cn(
                          "group flex shrink-0 items-start gap-2 rounded-lg border border-transparent px-2.5 py-2 text-left transition-[color,background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 lg:w-full",
                          isActive
                            ? "border-border bg-muted font-medium text-foreground shadow-xs"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        )}
                        href={`#${endpoint.id}`}
                        key={endpoint.id}
                        onClick={() => setActiveId(endpoint.id)}
                      >
                        <span
                          className={cn(
                            "mt-px rounded border px-1 py-0.5 font-mono text-[9px] leading-none",
                            isActive
                              ? "border-foreground/30 text-foreground"
                              : "border-border text-muted-foreground"
                          )}
                        >
                          {endpoint.method}
                        </span>
                        <span className="min-w-0">
                          <span className="block whitespace-nowrap text-xs">
                            {endpoint.title}
                          </span>
                          <code className="mt-1 hidden truncate font-mono text-[10px] font-normal text-muted-foreground lg:block">
                            {endpoint.path}
                          </code>
                        </span>
                      </a>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}
