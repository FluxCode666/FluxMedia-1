/**
 * 使用记录筛选的显式提交交互测试。
 *
 * 使用方：apps/web Vitest。锁定所有筛选控件只维护草稿，只有点击“查询”才把
 * 组合后的条件写入 URL，避免逐项选择时触发多次列表请求。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();

vi.mock("next-intl", () => ({ useLocale: () => "zh" }));
vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({ push }),
}));
vi.mock("@/features/navigation/navigation-feedback-event", () => ({
  requestNavigationFeedback: vi.fn(),
}));
vi.mock("./history-date-range-picker", () => ({
  HistoryDateRangePicker: ({
    onRangeChange,
  }: {
    onRangeChange: (range: {
      createdFrom: string;
      createdTo: string;
    }) => void;
  }) =>
    createElement(
      "button",
      {
        onClick: () =>
          onRangeChange({
            createdFrom: "2026-08-01",
            createdTo: "2026-08-13",
          }),
        type: "button",
      },
      "选择日期范围"
    ),
}));

import { HistoryFilters } from "./history-filters";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 挂载不含管理员用户条件的空筛选栏。 */
function renderFilters(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(HistoryFilters, {
        modelOptions: ["gpt-image-2"],
        state: {
          createdFrom: null,
          createdTo: null,
          cursor: null,
          model: null,
          page: 1,
          pageSize: 20,
          status: null,
          type: null,
          userEmail: null,
        },
      })
    );
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  push.mockReset();
  renderFilters();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("HistoryFilters", () => {
  it("stages selections and navigates only after clicking query", () => {
    const dateButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent === "选择日期范围");
    const queryButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent === "查询");

    expect(dateButton).not.toBeUndefined();
    expect(queryButton).not.toBeUndefined();
    act(() => dateButton?.click());
    expect(push).not.toHaveBeenCalled();

    act(() => queryButton?.click());
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      "/dashboard/history?createdFrom=2026-08-01&createdTo=2026-08-13"
    );
  });
});
