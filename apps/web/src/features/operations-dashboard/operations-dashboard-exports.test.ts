/**
 * 运营总览导出记录时区回归测试。
 *
 * 使用方：apps/web Vitest。通过真实服务端渲染锁定导出创建时间使用快照声明的
 * 应用时区，避免 UTC 与应用自然日边界不一致。
 */

import type { OperationsExportTask } from "@repo/shared/operations-dashboard/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useLocale: () => "zh-CN",
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("./actions", () => ({
  createOperationsExportAction: vi.fn(),
  listOperationsExportsAction: vi.fn(),
  prepareOperationsExportDownloadAction: vi.fn(),
  retryOperationsExportAction: vi.fn(),
}));

import { OperationsDashboardExports } from "./operations-dashboard-exports";

const exportTask: OperationsExportTask = {
  id: "export-1",
  exportType: "user_growth",
  status: "queued",
  query: { granularity: "day", range: { kind: "default" } },
  createdAt: "2026-08-13T16:30:00.000Z",
  completedAt: null,
  expiresAt: null,
  rowCount: null,
  byteCount: null,
  errorCode: null,
  retryOfTaskId: null,
};

describe("OperationsDashboardExports", () => {
  it("按应用时区展示跨 UTC 自然日的创建时间", () => {
    const html = renderToStaticMarkup(
      createElement(OperationsDashboardExports, {
        currentUserId: "admin-1",
        initialTasks: [exportTask],
        initialNextCursor: null,
        query: exportTask.query,
        timeZone: "Asia/Shanghai",
      })
    );

    expect(html).toContain("2026年8月14日");
    expect(html).not.toContain("2026年8月13日");
  });
});
