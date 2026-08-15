/**
 * 运营总览导出记录展示与异步请求竞态测试。
 *
 * 使用方：apps/web Vitest。通过服务端渲染锁定应用时区，并以可控 Promise 验证旧
 * 响应和卸载后的响应不能回写状态或触发通知。
 */
// @vitest-environment jsdom

import type { OperationsExportTask } from "@repo/shared/operations-dashboard/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  prepareDownload: vi.fn(),
  retry: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "zh-CN",
  useTranslations: () => (key: string) => key,
}));

vi.mock("@repo/ui/components/button", async () => {
  const { createElement: createReactElement } = await import("react");
  type TestButtonProps = import("react").ComponentProps<"button"> & {
    asChild?: boolean;
    size?: string;
    variant?: string;
  };
  return {
    Button: ({
      asChild,
      disabled,
      size,
      variant,
      ...buttonProps
    }: TestButtonProps) =>
      createReactElement("button", {
        ...buttonProps,
        "aria-disabled": disabled || undefined,
        "data-as-child": asChild || undefined,
        "data-size": size,
        "data-variant": variant,
      }),
  };
});

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

vi.mock("./actions", () => ({
  createOperationsExportAction: actionMocks.create,
  listOperationsExportsAction: actionMocks.list,
  prepareOperationsExportDownloadAction: actionMocks.prepareDownload,
  retryOperationsExportAction: actionMocks.retry,
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 创建由测试显式决定完成时机的 Promise。 */
function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error("Deferred 尚未初始化");
      resolvePromise(value);
    },
  };
}

/** 以指定首屏任务挂载真实导出组件。 */
function mountExports(initialTasks: OperationsExportTask[] = []): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(OperationsDashboardExports, {
        currentUserId: "admin-1",
        initialTasks,
        initialNextCursor: null,
        query: exportTask.query,
        timeZone: "Asia/Shanghai",
      })
    );
  });
}

/** 按翻译 key 查找组件按钮，缺失时立即让测试失败。 */
function findButton(label: string): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button")
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`未找到按钮: ${label}`);
  return button;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

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

  it("忽略晚于最新请求返回的旧刷新响应", async () => {
    const older = createDeferred<unknown>();
    const latest = createDeferred<unknown>();
    actionMocks.list
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise);
    mountExports();

    const refreshButton = findButton("exports.actions.refresh");
    act(() => refreshButton.click());
    act(() => findButton("exports.actions.refresh").click());
    expect(actionMocks.list).toHaveBeenCalledTimes(2);

    const latestTask: OperationsExportTask = {
      ...exportTask,
      exportType: "content_production",
      id: "latest-export",
    };
    await act(async () => {
      latest.resolve({ data: { nextCursor: null, tasks: [latestTask] } });
      await latest.promise;
    });

    const staleCompletedTask: OperationsExportTask = {
      ...exportTask,
      completedAt: "2026-08-15T08:00:00.000Z",
      id: "stale-export",
      status: "completed",
    };
    await act(async () => {
      older.resolve({
        data: { nextCursor: null, tasks: [staleCompletedTask] },
      });
      await older.promise;
    });

    const renderedTask = container?.querySelector("article")?.textContent;
    expect(renderedTask).toContain("exports.types.content_production");
    expect(renderedTask).not.toContain("exports.types.user_growth");
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("卸载后不处理延迟完成的下载响应", async () => {
    const pending = createDeferred<unknown>();
    actionMocks.prepareDownload.mockReturnValueOnce(pending.promise);
    const completedTask: OperationsExportTask = {
      ...exportTask,
      completedAt: "2026-08-15T08:00:00.000Z",
      status: "completed",
    };
    mountExports([completedTask]);

    act(() => findButton("exports.actions.download").click());
    act(() => root?.unmount());
    root = null;
    const assignDownload = vi.fn();
    vi.stubGlobal("window", { location: { assign: assignDownload } });

    pending.resolve({
      data: {
        downloadUrl: "https://download.test/export.csv",
        expiresAt: "2026-08-15T08:05:00.000Z",
        mode: "redirect",
        taskId: completedTask.id,
      },
    });
    await pending.promise;
    await Promise.resolve();

    expect(assignDownload).not.toHaveBeenCalled();
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});
