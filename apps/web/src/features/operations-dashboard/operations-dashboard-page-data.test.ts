/**
 * 运营总览首屏 UOL 装配测试。
 *
 * 使用方：Vitest；证明角色护栏、安全失败映射和 overview/导出独立降级。
 */
import type { OperationsExportTask } from "@repo/shared/operations-dashboard/contracts";
import { OperationError } from "@repo/shared/uol";
import { describe, expect, it, vi } from "vitest";

import { loadOperationsDashboardPageData } from "./operations-dashboard-page-data";
import type { OperationsDashboardOverview } from "./operations-dashboard-service";

const overview = {
  marker: "operations",
} as unknown as OperationsDashboardOverview;
const exportTask = {
  id: "export-1",
} as unknown as OperationsExportTask;

/** 创建成功依赖，单个测试只覆盖自己关心的失败或调用差异。 */
function createDependencies() {
  return {
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    invokeOverview: vi.fn().mockResolvedValue(overview),
    listExports: vi.fn().mockResolvedValue({
      tasks: [exportTask],
      nextCursor: "next-exports",
    }),
  };
}

describe("loadOperationsDashboardPageData", () => {
  it.each([
    "admin",
    "super_admin",
  ] as const)("%s 使用真实管理员 Principal 并行读取首屏", async (role) => {
    const dependencies = createDependencies();

    await expect(
      loadOperationsDashboardPageData(
        {
          userId: "admin-1",
          role,
          query: {
            granularity: "week",
            range: { kind: "this_month" },
          },
        },
        dependencies
      )
    ).resolves.toEqual({
      overview,
      exports: [exportTask],
      exportsNextCursor: "next-exports",
      loadError: null,
      exportsLoadError: null,
    });
    const principal = { type: "user", userId: "admin-1", role };
    expect(dependencies.ensureInitialized).toHaveBeenCalledOnce();
    expect(dependencies.invokeOverview).toHaveBeenCalledWith(
      {
        granularity: "week",
        range: { kind: "this_month" },
      },
      principal
    );
    expect(dependencies.listExports).toHaveBeenCalledWith(
      { limit: 20 },
      principal
    );
  });

  it.each([
    "user",
    "observer_admin",
  ] as const)("拒绝 %s 且不初始化 UOL", async (role) => {
    const dependencies = createDependencies();

    await expect(
      loadOperationsDashboardPageData(
        {
          userId: "user-1",
          role,
          query: { granularity: "day", range: { kind: "default" } },
        },
        dependencies
      )
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(dependencies.ensureInitialized).not.toHaveBeenCalled();
    expect(dependencies.invokeOverview).not.toHaveBeenCalled();
    expect(dependencies.listExports).not.toHaveBeenCalled();
  });

  it.each([
    [new OperationError("not_ready", "内部读模型信息"), "not_ready"],
    [new OperationError("rate_limited", "内部限流身份"), "rate_limited"],
    [new OperationError("timeout", "内部超时信息"), "timeout"],
    [new OperationError("internal_error", "秘密 SQL"), "unavailable"],
    [new Error("数据库口令"), "unavailable"],
  ] as const)("把 overview 失败收敛为安全状态", async (error, loadError) => {
    const dependencies = createDependencies();
    dependencies.invokeOverview.mockRejectedValue(error);

    await expect(
      loadOperationsDashboardPageData(
        {
          userId: "admin-1",
          role: "admin",
          query: { granularity: "day", range: { kind: "default" } },
        },
        dependencies
      )
    ).resolves.toEqual({
      overview: null,
      exports: [exportTask],
      exportsNextCursor: "next-exports",
      loadError,
      exportsLoadError: null,
    });
  });

  it("导出列表失败不阻断运营快照", async () => {
    const dependencies = createDependencies();
    dependencies.listExports.mockRejectedValue(
      new OperationError("timeout", "内部超时信息")
    );

    await expect(
      loadOperationsDashboardPageData(
        {
          userId: "admin-1",
          role: "admin",
          query: { granularity: "day", range: { kind: "default" } },
        },
        dependencies
      )
    ).resolves.toEqual({
      overview,
      exports: [],
      exportsNextCursor: null,
      loadError: null,
      exportsLoadError: "timeout",
    });
  });

  it("UOL 初始化失败同时关闭两个读取且返回安全不可用", async () => {
    const dependencies = createDependencies();
    dependencies.ensureInitialized.mockRejectedValue(new Error("绑定详情"));

    await expect(
      loadOperationsDashboardPageData(
        {
          userId: "admin-1",
          role: "admin",
          query: { granularity: "day", range: { kind: "default" } },
        },
        dependencies
      )
    ).resolves.toEqual({
      overview: null,
      exports: [],
      exportsNextCursor: null,
      loadError: "unavailable",
      exportsLoadError: "unavailable",
    });
    expect(dependencies.invokeOverview).not.toHaveBeenCalled();
    expect(dependencies.listExports).not.toHaveBeenCalled();
  });
});
