/**
 * Dashboard 侧栏的角色菜单与路径激活纯函数。
 *
 * 使用方是桌面侧栏和移动 Sheet；这里不读取会话、数据库或翻译，只把已规范化角色映射为
 * 可发现的菜单项，并用同一最长前缀规则计算 active href。菜单可见性不是权限边界。
 */
import type { AppUserRole } from "@repo/shared/auth/roles";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ChartNoAxesCombined,
  CreditCard,
  History,
  Megaphone,
  ReceiptText,
  Server,
  Settings,
  Shield,
  Users,
} from "lucide-react";

export type SidebarLeafItem = {
  title: string;
  href: string;
  icon?: LucideIcon;
};

export type SidebarNavItem = SidebarLeafItem & {
  items?: SidebarLeafItem[];
};

export type SidebarNavGroup = {
  title: string;
  items: SidebarNavItem[];
};

/** 生成管理员分组及其子项；只影响发现性，不替代页面和 Action 权限。 */
export function buildAdministrationItems(role: AppUserRole): SidebarNavItem[] {
  if (role === "observer_admin") {
    return [
      {
        title: "Global Status",
        href: "/dashboard/admin/status",
        icon: Activity,
      },
      {
        title: "Global Usage Records",
        href: "/dashboard/admin/history",
        icon: History,
      },
      {
        title: "Model Configuration",
        href: "/dashboard/admin/model-configuration",
        icon: Settings,
      },
      {
        title: "Supplier Management",
        href: "/dashboard/admin/suppliers",
        icon: Server,
      },
    ];
  }

  if (role !== "admin" && role !== "super_admin") return [];

  const items: SidebarNavItem[] = [
    {
      title: "Global Status",
      href: "/dashboard/admin/status",
      icon: Activity,
    },
    {
      title: "Admin Data Dashboard",
      href: "/dashboard/admin/analytics",
      icon: ChartNoAxesCombined,
    },
    {
      title: "Operations Dashboard",
      href: "/dashboard/admin/operations",
      icon: Activity,
    },
    {
      title: "User Management",
      href: "/dashboard/admin/users",
      icon: Users,
    },
    {
      title: "Global Usage Records",
      href: "/dashboard/admin/history",
      icon: History,
    },
    {
      title: "Order Management",
      href: "/dashboard/admin/payments",
      icon: ReceiptText,
      items: [
        {
          title: "Payment Overview",
          href: "/dashboard/admin/payments",
          icon: CreditCard,
        },
        {
          title: "Order Management",
          href: "/dashboard/admin/payments/orders",
          icon: ReceiptText,
        },
      ],
    },
    {
      title: "Announcement Management",
      href: "/dashboard/admin/announcements",
      icon: Megaphone,
    },
    {
      title: "Model Configuration",
      href: "/dashboard/admin/model-configuration",
      icon: Settings,
    },
    {
      title: "Supplier Management",
      href: "/dashboard/admin/suppliers",
      icon: Server,
    },
  ];

  if (role === "super_admin") {
    items.push({
      title: "System Settings",
      href: "/dashboard/admin/settings",
      icon: Shield,
    });
  }

  return items;
}

/** 去掉 locale 前缀并保证 dashboard 路径以斜杠开头。 */
export function normalizeSidebarPath(pathname: string): string {
  const withoutLocale = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, "");
  return withoutLocale.startsWith("/") ? withoutLocale : `/${withoutLocale}`;
}

/** 在同级候选中选择最长匹配路径，避免父路由抢占深层页面的 active 状态。 */
export function findMostSpecificActiveHref(
  pathname: string,
  items: readonly SidebarLeafItem[]
): string | null {
  const normalizedPath = normalizeSidebarPath(pathname);
  return (
    items
      .filter(
        (item) =>
          normalizedPath === item.href ||
          (item.href !== "/dashboard" &&
            normalizedPath.startsWith(`${item.href}/`))
      )
      .sort((left, right) => right.href.length - left.href.length)[0]?.href ??
    null
  );
}
