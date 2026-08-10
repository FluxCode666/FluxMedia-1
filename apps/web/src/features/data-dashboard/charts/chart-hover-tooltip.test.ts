/**
 * 数据看板图表浮窗交互测试。
 *
 * 使用方：Vitest；挂载真实 F2 图表，验证键盘聚焦真实日期点会显示数据浮窗，失焦
 * 后浮窗消失。测试不连接数据库或浏览器网络。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DataDashboardBucket } from "@repo/shared/analytics/contracts";

import { ImageHairlineLine } from "./image-hairline-line";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 挂载带单日真实点的图片趋势图。 */
function mountChart(): HTMLDivElement {
  const bucket: DataDashboardBucket = {
    date: "2026-08-10",
    start: "2026-08-10T00:00:00.000Z",
    end: "2026-08-11T00:00:00.000Z",
    imageCount: 3,
    imageTaskCount: 1,
    videoCount: 0,
    videoSeconds: 0,
    creditsConsumed: 12,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(ImageHairlineLine, {
        accessibleTitle: "Successful images",
        buckets: [bucket],
        descriptionId: "chart-description",
        titleId: "chart-title",
        tooltipValues: ["3 successful images"],
      })
    );
  });
  return container;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ChartHoverTooltip", () => {
  it("真实日期点获得键盘焦点时显示数据，失焦后隐藏", () => {
    const mounted = mountChart();
    const target = mounted.querySelector<HTMLButtonElement>(
      '[data-chart-tooltip-target="images"]'
    );

    expect(target).not.toBeNull();
    expect(mounted.querySelector('[data-chart-tooltip="true"]')).toBeNull();

    act(() => target?.focus());
    expect(
      mounted.querySelector('[data-chart-tooltip="true"]')?.textContent
    ).toContain("3 successful images");

    act(() => target?.blur());
    expect(mounted.querySelector('[data-chart-tooltip="true"]')).toBeNull();
  });
});
