/**
 * 数据看板 Lieflat 图表组合测试。
 *
 * 使用方：Vitest；以 React SSR 验证 F2/F3/L3/G4 模板、逐日位置、100 点构成、真实
 * 数据点浮窗命中层和视频数量/秒数的同快照切换数据。
 */
import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

import {
  DataDashboardCharts,
  selectVideoDashboardSeries,
} from "./data-dashboard-charts";

/** 创建指定天数且含两类成功任务的完整图表快照。 */
function createSnapshot(days: number): DataDashboardOutput {
  const buckets = Array.from({ length: days }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    start: new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
    end: new Date(Date.UTC(2026, 6, index + 2)).toISOString(),
    imageCount: index === 0 ? 4 : 0,
    imageTaskCount: index === 0 ? 1 : 0,
    videoCount: index === 1 ? 1 : 0,
    videoSeconds: index === 1 ? 5 : 0,
    creditsConsumed: index === 0 ? 60 : 0,
  }));
  return {
    asOf: "2026-08-09T10:15:30.000Z",
    timeZone: "UTC",
    today: "2026-08-09",
    range: {
      startDate: buckets[0]?.date ?? "2026-07-01",
      endDate: buckets.at(-1)?.date ?? "2026-07-01",
      start: buckets[0]?.start ?? "2026-07-01T00:00:00.000Z",
      end: buckets.at(-1)?.end ?? "2026-07-02T00:00:00.000Z",
    },
    metrics: {
      imageCount: 4,
      videoSeconds: 5,
      creditsConsumed: 60,
      successRate: { succeeded: 2, failed: 0, terminal: 2, rate: 1 },
      activeDays: 2,
      mostUsedModel: { model: "model-a", taskCount: 1 },
    },
    buckets,
    taskComposition: {
      imageTaskCount: 1,
      videoCount: 1,
      totalTasks: 2,
    },
  };
}

describe("DataDashboardCharts", () => {
  it.each([7, 30])("以四个真实模板渲染 %d 天位置和浮窗命中层", (days) => {
    const html = renderToStaticMarkup(
      createElement(DataDashboardCharts, { snapshot: createSnapshot(days) })
    );

    for (const template of [
      "F2-hairline-line",
      "F3-hairline-area",
      "L3-barcode-lollipop",
      "G4-dot-waffle",
    ]) {
      expect(html).toContain(`data-lieflat-template="${template}"`);
    }
    expect(html.match(/data-image-day=/g)).toHaveLength(days);
    expect(html.match(/data-credit-day=/g)).toHaveLength(days);
    expect(html.match(/data-video-day=/g)).toHaveLength(days);
    expect(html.match(/data-waffle-dot=/g)).toHaveLength(100);
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("charts.table.show");
    expect(html.match(/data-chart-tooltip-target="images"/g)).toHaveLength(
      days
    );
    expect(html.match(/data-chart-tooltip-target="credits"/g)).toHaveLength(
      days
    );
    expect(html.match(/data-chart-tooltip-target="videos"/g)).toHaveLength(
      days
    );
    expect(html).toContain('data-chart-tooltip-target="composition-image"');
    expect(html).toContain('data-chart-tooltip-target="composition-video"');
    expect(html.match(/charts\.replay/g)).toHaveLength(4);
    expect(html).not.toMatch(/iframe|dangerouslySetInnerHTML|javascript:/i);
  });

  it("视频数量和秒数读取同一快照中的独立序列", () => {
    const snapshot = createSnapshot(7);

    expect(selectVideoDashboardSeries(snapshot, "count")).toEqual([
      0, 1, 0, 0, 0, 0, 0,
    ]);
    expect(selectVideoDashboardSeries(snapshot, "seconds")).toEqual([
      0, 5, 0, 0, 0, 0, 0,
    ]);
  });
});
