/**
 * 独立分组管理面板的 DOM 契约测试。
 *
 * 使用方：apps/web Vitest。文件使用 `.test.ts`，以匹配现有收集规则；通过 mock
 * Action 和分页控件锁定标题、筛选、创建入口与 observer_admin 只读状态，不连接
 * UOL、数据库或调度服务。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: mocks.execute, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/i18n/routing", () => ({
  usePathname: () => "/dashboard/admin/supplier-groups",
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock("@/features/model-configuration/actions", () => ({
  getModelConfigurationAction: vi.fn(),
}));
vi.mock("@/features/pagination/pagination-controls", () => ({
  UrlPaginationControls: () => null,
}));
vi.mock("@/features/pagination/url-page-size-select", () => ({
  UrlPageSizeSelect: () => null,
}));
vi.mock("./actions", () => ({
  deleteImageBackendGroupAction: vi.fn(),
  getAdminImageBackendPoolAction: vi.fn(),
  listAdminImageBackendGroupsAction: vi.fn(),
}));
vi.mock("./group-form", () => ({
  BackendGroupFormDialog: ({ open }: { open: boolean }) =>
    open ? createElement("div", { role: "dialog" }, "分组计费覆盖表单") : null,
}));

import { BackendGroupAdminPanel } from "./backend-group-admin-panel";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 挂载分组面板并等待 React 提交副作用。 */
function mount(readOnly: boolean): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(BackendGroupAdminPanel, {
        paginationConfig: {
          defaultPageSize: 20,
          pageSizeOptions: [10, 20, 50],
        },
        readOnly,
        readOnlyNotice: "分组只读提示",
        title: "分组管理",
      })
    );
  });
}

describe("BackendGroupAdminPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  it("展示独立标题、名称筛选和分组计费覆盖入口", () => {
    mount(false);

    expect(container?.querySelector("h2")?.textContent).toBe("分组管理");
    expect(
      container?.querySelector('input[placeholder="按分组名称模糊搜索"]')
    ).not.toBeNull();
    const addButton = Array.from(
      container?.querySelectorAll("button") ?? []
    ).find((button) => button.textContent?.includes("新增分组"));
    expect(addButton).toBeDefined();

    act(() => addButton?.click());
    expect(container?.textContent).toContain("分组计费覆盖表单");
  });

  it("只读状态显示提示并隐藏所有分组写入口", () => {
    mount(true);

    expect(container?.textContent).toContain("分组只读提示");
    expect(container?.textContent).not.toContain("新增分组");
    expect(container?.querySelector('[role="dialog"]')).toBeNull();
  });
});
