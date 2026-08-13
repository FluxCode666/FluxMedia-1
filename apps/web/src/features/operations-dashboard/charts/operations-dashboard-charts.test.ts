/**
 * 运营总览 Lieflat 图表组件级回归测试。
 *
 * 使用方：apps/web Vitest。测试以真实 React 根节点验证视频数量/秒数只在本地切换，
 * 并以服务端渲染锁定图表使用 shadcn ChartContainer 与未降采样的完整等价表。
 */
// @vitest-environment jsdom

import type { OperationsNumericSeriesBucket } from "@repo/shared/operations-dashboard/series";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationsImageChart } from "./image-production-chart";
import {
  OperationsVideoChart,
  type OperationsVideoChartLabels,
} from "./video-production-chart";

const labels: OperationsVideoChartLabels = {
  title: "视频产量",
  description: "按当前日期范围统计成功视频。",
  source: "来源：成功视频事实表",
  modeLabel: "视频指标",
  count: "视频数量",
  seconds: "视频秒数",
  navigation: "使用方向键浏览完整序列",
  tableOpen: "展开完整数据表",
  tableCaption: "视频产量完整数据",
  date: "日期",
  status: "状态",
  valueStatus: "有数据",
  value: "数值",
  preEpoch: "上线前",
};

/** 构造带稳定日期标签的完整运营序列。 */
function createSeries(
  values: readonly number[]
): OperationsNumericSeriesBucket[] {
  return values.map((value, index) => {
    const day = String(index + 1).padStart(2, "0");
    const nextDay = String(index + 2).padStart(2, "0");
    return {
      key: `2026-08-${day}`,
      granularity: "day" as const,
      from: `2026-08-${day}`,
      to: `2026-08-${day}`,
      start: new Date(`2026-08-${day}T00:00:00.000Z`),
      end: new Date(`2026-08-${nextDay}T00:00:00.000Z`),
      availability: "available" as const,
      dataFrom: new Date(`2026-08-${day}T00:00:00.000Z`),
      status: "value" as const,
      value,
    };
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 在 jsdom 中挂载视频趋势图。 */
function mountVideoChart(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(OperationsVideoChart, {
        countSeries: createSeries([2, 4]),
        secondsSeries: createSeries([8, 16]),
        labels,
        locale: "zh-CN",
      })
    );
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as typeof ResizeObserver;
  globalThis.PointerEvent ??= MouseEvent as typeof PointerEvent;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("operations dashboard charts", () => {
  it("视频数量与秒数在同一快照内切换并同步完整表格", () => {
    mountVideoChart();

    expect(container?.textContent).toContain("2");
    expect(container?.textContent).toContain("4");
    expect(container?.textContent).not.toContain("16");

    const secondsTab = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? []
    ).find((button) => button.textContent === labels.seconds);
    expect(secondsTab).not.toBeUndefined();
    act(() =>
      secondsTab?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 })
      )
    );

    expect(container?.textContent).toContain("8");
    expect(container?.textContent).toContain("16");
    expect(
      container?.querySelector('[role="img"]')?.getAttribute("aria-label")
    ).toContain(labels.seconds);
  });

  it("图表使用 shadcn 容器并保留全部桶的等价表", () => {
    const series = createSeries([3, 5, 7]);
    const html = renderToStaticMarkup(
      createElement(OperationsImageChart, {
        labels: {
          title: "生图数量",
          description: "成功生图趋势。",
          source: "来源：成功图片事实表",
          series: "生图数量",
          navigation: "使用方向键浏览完整序列",
          tableOpen: "展开完整数据表",
          tableCaption: "生图数量完整数据",
          date: "日期",
          status: "状态",
          valueStatus: "有数据",
          value: "数值",
          preEpoch: "上线前",
        },
        locale: "zh-CN",
        series,
      })
    );

    expect(html).toContain('data-slot="chart"');
    expect(html).toContain("<details");
    expect(html).toContain("<table");
    expect(html.match(/scope="row"/g)).toHaveLength(series.length);
    expect(html).toContain("2026年8月1日");
    expect(html).toContain("2026年8月2日");
    expect(html).toContain("2026年8月3日");
  });
});
