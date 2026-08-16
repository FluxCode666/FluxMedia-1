/**
 * 账号池管理筛选栏与分组列表的 DOM 契约测试。
 *
 * 职责：锁定分组使用语义表格、只读模式隐藏写操作，以及供应商账号筛选器暴露
 * 名称、凭据健康、模型、创建日期范围和清除交互；不调用 Server Action 或数据库。
 */
// @vitest-environment jsdom

import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
import { act, createElement, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendGroupList } from "./admin-group-list";
import { BackendMemberFilterBar } from "./admin-pool-filter-bars";
import {
  type BackendMemberFilters,
  EMPTY_BACKEND_MEMBER_FILTERS,
} from "./admin-pool-view-model";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 构造分组列表使用的完整摘要。 */
function createGroup(
  overrides: Partial<BackendGroupSummary> = {}
): BackendGroupSummary {
  return {
    id: "group-primary",
    name: "主分组",
    description: "生产供应商账号",
    isEnabled: true,
    isDefault: false,
    isUserSelectable: true,
    contentSafety: "inherit",
    imageCreditOverrides: { version: 1, byModel: {} },
    videoCreditOverrides: {},
    videoCreditsPerItemOverrides: {},
    childGroupIds: [],
    priority: 10,
    ...overrides,
  };
}

/** 挂载指定 React 节点并同步刷新 DOM。 */
function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

/** 通过原生 setter 触发 React 可观察的输入事件。 */
function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("admin pool components", () => {
  it("使用语义表格展示分组并在只读模式隐藏操作列", () => {
    const group = createGroup();
    mount(
      createElement(BackendGroupList, {
        groups: [group],
        allGroups: [group],
        memberCountByGroup: new Map([[group.id, 3]]),
        readOnly: true,
        isDeleting: false,
        hasNameFilter: false,
        onEdit: vi.fn(),
        onDelete: vi.fn(),
      })
    );

    expect(container?.querySelector("table")).not.toBeNull();
    expect(container?.querySelector("th[scope='col']")?.textContent).toContain(
      "分组"
    );
    expect(container?.textContent).toContain("主分组");
    expect(container?.textContent).toContain("生产供应商账号");
    expect(container?.textContent).toContain("3");
    expect(container?.textContent).not.toContain("操作");
    expect(container?.querySelector("button")).toBeNull();
  });

  it("分组名称筛选无结果时显示明确空态", () => {
    mount(
      createElement(BackendGroupList, {
        groups: [],
        allGroups: [createGroup()],
        memberCountByGroup: new Map(),
        readOnly: false,
        isDeleting: false,
        hasNameFilter: true,
        onEdit: vi.fn(),
        onDelete: vi.fn(),
      })
    );

    expect(container?.textContent).toContain("没有符合名称条件的分组");
  });

  it("供应商账号筛选器提供全部条件并支持清除", () => {
    /** 持有真实受控值，验证输入与清除按钮能完成一轮状态更新。 */
    function FilterHarness() {
      const [filters, setFilters] = useState<BackendMemberFilters>({
        ...EMPTY_BACKEND_MEMBER_FILTERS,
      });
      return createElement(BackendMemberFilterBar, {
        filters,
        modelOptions: [{ id: "gpt-image-2", label: "GPT Image 2" }],
        resultCount: 1,
        totalCount: 2,
        timeZone: "Asia/Shanghai",
        invalidDateRange: false,
        onChange: setFilters,
      });
    }

    mount(createElement(FilterHarness));

    const searchInput = container?.querySelector<HTMLInputElement>(
      'input[placeholder="输入名称片段"]'
    );
    const dateRangeButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-labelledby="backend-member-created-range-label"]'
    );
    expect(searchInput).not.toBeNull();
    expect(container?.querySelector('input[type="date"]')).toBeNull();
    expect(dateRangeButton?.textContent).toContain("全部创建日期");
    expect(container?.textContent).toContain("凭据状态（Adobe Direct）");
    expect(container?.textContent).toContain("全部凭据状态");
    expect(container?.textContent).toContain("支持的模型");

    act(() => dateRangeButton?.click());
    expect(document.body.textContent).toContain("选择创建日期范围");
    expect(
      document.body.querySelector('[data-slot="calendar"]')
    ).not.toBeNull();

    act(() => {
      if (!searchInput) return;
      changeInput(searchInput, "backup");
    });

    const clearButton = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? []
    ).find((button) => button.textContent?.includes("清除筛选"));
    expect(clearButton).toBeDefined();
    act(() => clearButton?.click());
    expect(searchInput?.value).toBe("");
  });
});
