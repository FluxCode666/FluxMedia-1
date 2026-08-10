/**
 * 用户数据看板从共享契约到页面图表的 DB-free 跨层合同测试。
 *
 * 使用方：Vitest；以固定 Asia/Shanghai 数据把日期解析、UOL 权限和输出校验、页面
 * 装配、客户端原子状态与四张 shadcn/ui 图表串成同一条真实类型链，避免范围漂移。
 */
import {
  type DataDashboardInput,
  type DataDashboardOutput,
  dataDashboardOutputSchema,
} from "@repo/shared/analytics/contracts";
import { resolveDataDashboardRange } from "@repo/shared/analytics/data-dashboard-range";
import "@repo/shared/uol/operations/analytics";
import { bindExecute, invokeOperation, type Principal } from "@repo/shared/uol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useLocale: () => "zh-CN",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

import { DataDashboardCharts } from "./charts/data-dashboard-charts";
import { loadDataDashboardPageData } from "./data-dashboard-page-data";
import {
  applyDataDashboardActionResult,
  type DataDashboardViewState,
} from "./data-dashboard-state";

const fixedAsOf = new Date("2026-08-09T10:15:30.000Z");

/**
 * 以真实范围 resolver 构造可通过全部跨字段 invariant 的固定快照。
 *
 * @param input UOL 已验证的默认或成对日期输入。
 * @returns 图片多产物、视频秒数和失败任务均可区分的完整同一时钟 DTO。
 */
function buildFixedSnapshot(input: DataDashboardInput): DataDashboardOutput {
  const range = resolveDataDashboardRange(input, {
    timeZone: "Asia/Shanghai",
    asOf: fixedAsOf,
  });
  const buckets = range.buckets.map((bucket, index) => ({
    date: bucket.date,
    start: bucket.start.toISOString(),
    end: bucket.end.toISOString(),
    imageCount: index === 0 ? 4 : 0,
    imageTaskCount: index === 0 ? 1 : 0,
    videoCount: index === 1 ? 1 : 0,
    videoSeconds: index === 1 ? 5 : 0,
    creditsConsumed: index === 0 ? 60 : 0,
  }));
  return dataDashboardOutputSchema.parse({
    asOf: range.asOf.toISOString(),
    timeZone: range.timeZone,
    today: range.today,
    range: {
      startDate: range.startDate,
      endDate: range.endDate,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    metrics: {
      imageCount: 4,
      videoSeconds: 5,
      creditsConsumed: 60,
      successRate: {
        succeeded: 2,
        failed: 1,
        terminal: 3,
        rate: 2 / 3,
      },
      activeDays: 2,
      mostUsedModel: { model: "model-a", taskCount: 1 },
    },
    buckets,
    taskComposition: {
      imageTaskCount: 1,
      videoCount: 1,
      totalTasks: 2,
    },
  });
}

/** 让页面装配器通过真实 UOL 网关调用当前测试绑定。 */
async function invokeDashboard(
  input: DataDashboardInput,
  principal: Principal
): Promise<DataDashboardOutput> {
  return invokeOperation<DataDashboardOutput>(
    "analytics.getMyDataDashboard",
    input,
    principal,
    { requestId: "data-dashboard-integration" }
  );
}

describe("data dashboard cross-layer contract", () => {
  it("固定账号时区时钟从 UOL 到原子状态和四图保持同一范围与 asOf", async () => {
    let executedPrincipal: Principal | null = null;
    bindExecute(
      "analytics.getMyDataDashboard",
      async (input: DataDashboardInput, principal: Principal) => {
        executedPrincipal = principal;
        return buildFixedSnapshot(input);
      }
    );

    const snapshot = await loadDataDashboardPageData(
      {
        userId: "user-a",
        role: "user",
        rangeInput: {},
      },
      {
        ensureInitialized: async () => undefined,
        invokeDashboard,
      }
    );
    const emptyState: DataDashboardViewState = {
      snapshot: null,
      appliedRange: null,
      requestStatus: "error",
      failureStatus: "unavailable",
    };
    const view = applyDataDashboardActionResult(emptyState, {
      status: "ready",
      snapshot,
    });
    const html = renderToStaticMarkup(
      createElement(DataDashboardCharts, { snapshot })
    );

    expect(executedPrincipal).toEqual({
      type: "user",
      userId: "user-a",
      role: "user",
    });
    expect(snapshot.asOf).toBe(fixedAsOf.toISOString());
    expect(snapshot.today).toBe("2026-08-09");
    expect(snapshot.range).toMatchObject({
      startDate: "2026-08-03",
      endDate: "2026-08-09",
    });
    expect(snapshot.buckets).toHaveLength(7);
    expect(view).toMatchObject({
      appliedRange: {
        startDate: "2026-08-03",
        endDate: "2026-08-09",
      },
      requestStatus: "idle",
      failureStatus: null,
    });
    expect(html).toContain('data-dashboard-chart="images-line"');
    expect(html).toContain('data-dashboard-chart="credits-bar"');
    expect(html).toContain('data-dashboard-chart="videos-bar-count"');
    expect(html).toContain('data-dashboard-chart="composition-donut"');
    expect(html).toContain("2026-08-03");
    expect(html).toContain("2026-08-09");
  });

  it("UOL 在执行绑定前拒绝伪造身份字段和非 session user Principal", async () => {
    let executionCount = 0;
    bindExecute(
      "analytics.getMyDataDashboard",
      async (input: DataDashboardInput) => {
        executionCount += 1;
        return buildFixedSnapshot(input);
      }
    );

    await expect(
      invokeOperation(
        "analytics.getMyDataDashboard",
        { userId: "another-user" },
        {
          type: "user",
          userId: "user-a",
          role: "user",
        }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      invokeOperation(
        "analytics.getMyDataDashboard",
        {},
        {
          type: "apiKey",
          credentialKind: "mcp",
          userId: "user-a",
          apiKeyId: "key-a",
        }
      )
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(executionCount).toBe(0);
  });
});
