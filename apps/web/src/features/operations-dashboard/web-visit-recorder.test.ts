/**
 * Dashboard 网页访问记录器组件生命周期测试。
 *
 * 使用方：Vitest。挂载真实客户端组件并模拟页面重新可见，验证跨应用日门禁、请求
 * 完成后的恢复和卸载清理；不调用真实 Server Action 或数据库。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionHarness = vi.hoisted(() => ({
  execute: vi.fn(),
  callbacks: null as null | {
    onSuccess(input: {
      data?:
        | { status: "recorded"; appDate: string }
        | { status: "unavailable" };
    }): void;
    onError(): void;
  },
}));

vi.mock("next-safe-action/hooks", () => ({
  useAction: (
    _action: unknown,
    callbacks: NonNullable<typeof actionHarness.callbacks>
  ) => {
    actionHarness.callbacks = callbacks;
    return { execute: actionHarness.execute };
  },
}));

vi.mock("./actions", () => ({
  recordDashboardWebVisitAction: {},
}));

import { DashboardWebVisitRecorder } from "./web-visit-recorder";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 挂载记录器并同步执行 visibilitychange effect。 */
function mountRecorder(initialRecordedAppDate: string | null): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(DashboardWebVisitRecorder, {
        appTimeZone: "Asia/Shanghai",
        initialRecordedAppDate,
      })
    )
  );
}

/** 派发一次页面重新可见事件。 */
function showDocument(): void {
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-14T04:00:00.000Z"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  actionHarness.execute.mockReset();
  actionHarness.callbacks = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("DashboardWebVisitRecorder", () => {
  it("跨应用日只发起一个请求，并在失败后释放门禁", () => {
    mountRecorder("2026-08-13");

    showDocument();
    showDocument();
    expect(actionHarness.execute).toHaveBeenCalledOnce();

    act(() => actionHarness.callbacks?.onError());
    showDocument();
    expect(actionHarness.execute).toHaveBeenCalledTimes(2);
  });

  it("成功后记录服务端日期，卸载后移除监听", () => {
    mountRecorder("2026-08-13");
    showDocument();
    act(() =>
      actionHarness.callbacks?.onSuccess({
        data: { status: "recorded", appDate: "2026-08-14" },
      })
    );
    showDocument();
    expect(actionHarness.execute).toHaveBeenCalledOnce();

    act(() => root?.unmount());
    root = null;
    vi.setSystemTime(new Date("2026-08-15T04:00:00.000Z"));
    showDocument();
    expect(actionHarness.execute).toHaveBeenCalledOnce();
  });
});
