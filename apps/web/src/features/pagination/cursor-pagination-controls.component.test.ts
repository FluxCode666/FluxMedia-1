/**
 * 共享游标分页数字页码交互测试。
 *
 * 使用方：历史与支付订单列表；锁定桌面端所有展示数字均可跳转，同时保留当前页
 * 语义、禁用态和不可交互省略号。
 */
// @vitest-environment jsdom

import { getPaginationWindow } from "@repo/shared/pagination/state";
import { CursorPaginationControls } from "@repo/ui/components/cursor-pagination-controls";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderControls(input?: {
  disabled?: boolean;
  onPageChange?: (page: number) => void;
}): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(CursorPaginationControls, {
        ariaLabel: "分页",
        currentPageLabel: "第 5 / 10 页",
        currentPageLabelTemplate: "第 {page} 页，当前页",
        disabled: input?.disabled,
        hasNext: true,
        hasPrevious: true,
        items: getPaginationWindow(5, 10),
        nextLabel: "下一页",
        onNext: vi.fn(),
        onPageChange: input?.onPageChange ?? vi.fn(),
        onPrevious: vi.fn(),
        page: 5,
        pageLabelTemplate: "前往第 {page} 页",
        previousLabel: "上一页",
        totalPages: 10,
      })
    );
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("CursorPaginationControls", () => {
  it("makes every displayed non-current page number clickable", () => {
    const onPageChange = vi.fn();
    renderControls({ onPageChange });

    const pageButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button")
    ).filter((button) => /^\d+$/.test(button.textContent?.trim() ?? ""));
    expect(pageButtons.map((button) => button.textContent)).toEqual([
      "1",
      "4",
      "6",
      "10",
    ]);

    act(() => pageButtons[0]?.click());
    act(() => pageButtons.at(-1)?.click());
    expect(onPageChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 10);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(2);
    expect(
      document.querySelectorAll('[data-slot="pagination-ellipsis"]')
    ).toHaveLength(2);
  });

  it("disables every displayed page jump while navigation is pending", () => {
    renderControls({ disabled: true });

    const pageButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button")
    ).filter((button) => /^\d+$/.test(button.textContent?.trim() ?? ""));
    expect(pageButtons).toHaveLength(4);
    expect(pageButtons.every((button) => button.disabled)).toBe(true);
  });
});
