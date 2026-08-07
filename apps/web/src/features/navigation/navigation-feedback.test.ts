/**
 * 全站导航进度条组件级回归测试。
 *
 * 使用方是 Vitest；挂载真实反馈组件并模拟 App Router 路由提交，验证连续提交不会
 * 破坏完成态的延迟收起计时。测试不执行真实导航、网络或服务端请求。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_FEEDBACK_START_EVENT } from "./navigation-feedback-event";
import {
  NAVIGATION_PROGRESS_COMPLETE_DELAY_MS,
  NAVIGATION_PROGRESS_DELAY_MS,
} from "./navigation-progress";

const testHarness = vi.hoisted(() => ({
  pathname: "/zh/dashboard",
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => testHarness.pathname,
  useSearchParams: () => new URLSearchParams(testHarness.search),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { NavigationFeedback } from "./navigation-feedback";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * 挂载真实导航反馈组件并执行初始 effect。
 *
 * @returns 包含进度条 DOM 的根容器。
 * @sideEffects 向 document.body 添加 React 根节点并注册全局导航监听。
 * @failure 组件渲染失败时由 React 或测试环境直接抛错。
 */
function mountNavigationFeedback(): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(NavigationFeedback)));
  return container;
}

/**
 * 更新模拟路由并重渲染组件，以触发 App Router 提交监听。
 *
 * @param pathname 下一次提交的路径。
 * @sideEffects 修改测试路由夹具并同步执行 React effect。
 * @failure 组件尚未挂载时不执行渲染。
 */
function commitRoute(pathname: string): void {
  testHarness.pathname = pathname;
  act(() => root?.render(createElement(NavigationFeedback)));
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  testHarness.pathname = "/zh/dashboard";
  testHarness.search = "";
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("NavigationFeedback", () => {
  it("先给路由鱼骨屏机会，再显示顶部进度兜底", () => {
    const mounted = mountNavigationFeedback();

    act(() => window.dispatchEvent(new Event(NAVIGATION_FEEDBACK_START_EVENT)));
    expect(mounted.querySelector('[role="progressbar"]')).toBeNull();

    act(() => vi.advanceTimersByTime(NAVIGATION_PROGRESS_DELAY_MS - 1));
    expect(mounted.querySelector('[role="progressbar"]')).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(mounted.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it("完成停留期内连续提交路由后仍按期收起", () => {
    const mounted = mountNavigationFeedback();

    act(() => window.dispatchEvent(new Event(NAVIGATION_FEEDBACK_START_EVENT)));
    act(() => vi.advanceTimersByTime(NAVIGATION_PROGRESS_DELAY_MS));
    expect(mounted.querySelector('[role="progressbar"]')).not.toBeNull();

    commitRoute("/zh/dashboard/gallery");
    expect(
      mounted
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow")
    ).toBe("100");

    commitRoute("/zh/dashboard/gallery/redirected");
    act(() => vi.advanceTimersByTime(NAVIGATION_PROGRESS_COMPLETE_DELAY_MS));

    expect(mounted.querySelector('[role="progressbar"]')).toBeNull();
  });
});
