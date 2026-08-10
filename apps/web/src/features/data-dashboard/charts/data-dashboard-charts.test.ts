/**
 * 数据看板 shadcn/ui 图表组合测试。
 *
 * 使用方：Vitest；以 React SSR 验证四张用户熟悉的图表类型、无管理端 Lieflat 标记，
 * 并验证视频数量/秒数读取同一快照中的独立序列。
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
  it.each([7, 30])("以四种常规图表渲染 %d 天快照", (days) => {
    const html = renderToStaticMarkup(
      createElement(DataDashboardCharts, { snapshot: createSnapshot(days) })
    );

    expect(html).toContain('data-dashboard-chart="images-line"');
    expect(html).toContain('data-dashboard-chart="credits-bar"');
    expect(html).toContain('data-dashboard-chart="videos-bar-count"');
    expect(html).toContain('data-dashboard-chart="composition-donut"');
    expect(html.match(/data-slot="chart"/g)).toHaveLength(4);
    expect(html).not.toContain("data-lieflat-template");
    expect(html).not.toMatch(/hairline|barcode|waffle/i);
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<details");
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
