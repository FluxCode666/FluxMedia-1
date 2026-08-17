/**
 * Dashboard 侧栏分组管理入口的渲染契约。
 *
 * 使用方：apps/web Vitest。通过 jsdom 渲染 observer_admin 的中文侧栏，锁定消息键、
 * 本地化 href 与移动 Sheet 关闭行为，不调用会话接口或未读计数 Action。
 */
// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setMobileOpen: vi.fn(),
}));

vi.mock("@repo/shared/announcements/actions", () => ({
  getMyUnreadAnnouncementCountAction: vi.fn(),
}));
vi.mock("@repo/shared/auth/client", () => ({ signOut: vi.fn() }));
vi.mock("@repo/shared/auth/roles", () => ({
  normalizeUserRole: (role: string | undefined) => role ?? "user",
}));
vi.mock("@repo/shared/components", () => ({ ModeToggle: () => null }));
vi.mock("@repo/shared/config", () => ({ dashboardConfig: { sidebarNav: [] } }));
vi.mock("@repo/shared/credits/components", () => ({
  CreditBalanceBadge: () => null,
}));
vi.mock("@repo/shared/support/actions/ticket", () => ({
  getMyUnreadTicketCountAction: vi.fn(),
}));
vi.mock("@repo/ui/components/avatar", () => ({
  Avatar: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  AvatarFallback: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
  AvatarImage: () => null,
}));
vi.mock("@repo/ui/components/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  PopoverContent: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  PopoverTrigger: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@repo/ui/components/separator", () => ({
  Separator: () => createElement("hr"),
}));
vi.mock("@repo/ui/components/sheet", () => ({
  Sheet: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  SheetContent: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  SheetTitle: ({ children }: { children?: ReactNode }) =>
    createElement("h2", null, children),
}));
vi.mock("@repo/ui/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
}));
vi.mock("lucide-react", () => ({
  Activity: () => null,
  Boxes: () => null,
  ChartNoAxesCombined: () => null,
  ChevronRight: () => null,
  ChevronsUpDown: () => null,
  CreditCard: () => null,
  History: () => null,
  Loader2: () => null,
  LogOut: () => null,
  Megaphone: () => null,
  ReceiptText: () => null,
  Server: () => null,
  Settings: () => null,
  Shield: () => null,
  Users: () => null,
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    onClick,
  }: {
    children?: ReactNode;
    href: string;
    onClick?: () => void;
  }) =>
    createElement(
      "a",
      {
        href,
        onClick,
      },
      children
    ),
  useLinkStatus: () => ({ pending: false }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/zh/dashboard/admin/supplier-groups",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "zh",
  useTranslations: () => (key: string) =>
    key === "nav.groupManagement" ? "分组管理" : key,
}));
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: vi.fn(), result: { data: { count: 0 } } }),
}));
vi.mock("@/features/auth/hooks/use-current-session", () => ({
  useCurrentSession: () => ({
    data: {
      user: {
        email: "observer@example.com",
        id: "observer-1",
        name: "Observer",
        role: "observer_admin",
      },
    },
  }),
}));
vi.mock("@/features/branding/site-logo", () => ({ SiteLogo: () => null }));
vi.mock("@/features/dashboard/context", () => ({
  useSidebar: () => ({
    isCollapsed: false,
    isMobileOpen: true,
    setMobileOpen: mocks.setMobileOpen,
    toggleSidebar: vi.fn(),
  }),
}));
vi.mock("@/features/navigation/navigation-feedback-event", () => ({
  requestNavigationFeedback: vi.fn(),
}));

import { DashboardSidebar } from "./sidebar";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.setMobileOpen.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("DashboardSidebar", () => {
  it("为中文 observer_admin 渲染分组管理并在移动端点击后关闭 Sheet", () => {
    act(() => root?.render(createElement(DashboardSidebar)));

    const groupLinks = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>(
        'a[href="/zh/dashboard/admin/supplier-groups"]'
      ) ?? []
    );

    expect(groupLinks).toHaveLength(2);
    expect(groupLinks.every((link) => link.textContent?.includes("分组管理"))).toBe(
      true
    );
    expect(container?.textContent).not.toContain("Group Management");

    act(() => groupLinks.at(-1)?.click());

    expect(mocks.setMobileOpen).toHaveBeenCalledWith(false);
  });
});
