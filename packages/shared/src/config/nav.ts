/**
 * 全站导航配置与营销 Header 契约。
 *
 * 使用方：营销 Header、移动端 Sheet、Footer、Dashboard 与 Admin 侧栏。
 * 关键依赖：Lucide 图标；营销链接保持 locale-neutral，由应用层 i18n Link
 * 统一添加当前语言前缀。
 */
import {
  BookOpen,
  ChartNoAxesCombined,
  Clock,
  GalleryHorizontalEnd,
  Headset,
  Image,
  KeyRound,
  Layers,
  LayoutDashboard,
  type LucideIcon,
  Megaphone,
  Settings,
  Share2,
  Ticket,
  Users,
  WalletCards,
} from "lucide-react";

/**
 * 导航链接类型
 */
export interface NavItem {
  title: string;
  href: string;
  disabled?: boolean;
  external?: boolean;
  icon?: LucideIcon;
  description?: string;
}

/**
 * 导航分组类型
 */
export interface NavGroup {
  title: string;
  items: NavItem[];
}

// ============================================
// Marketing 导航配置
// ============================================

/**
 * 主导航链接 (Header)
 */
export const mainNav: NavItem[] = [
  { title: "Models", href: "/models" },
  { title: "Docs", href: "/api-docs" },
];

/**
 * Footer 导航配置
 */
export const footerNav = {
  /** 产品 (Product) */
  product: [
    { title: "Models", href: "/models" },
    { title: "Docs", href: "/api-docs" },
    {
      title: "Contact Us",
      href: "mailto:support@media.flux-code.cc",
      external: true,
    },
  ] as NavItem[],

  /** 法律 (Legal) */
  legal: [
    { title: "Terms of Service", href: "/legal/terms" },
    { title: "Privacy Policy", href: "/legal/privacy" },
    { title: "Cookie Policy", href: "/legal/cookie-policy" },
  ] as NavItem[],
};

// ============================================
// Dashboard 导航配置
// ============================================

/**
 * Dashboard 侧边栏导航分组
 */
export const dashboardNav: NavGroup[] = [
  {
    title: "Dashboard",
    items: [
      {
        title: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
      },
      {
        title: "Data dashboard",
        href: "/dashboard/analytics",
        icon: ChartNoAxesCombined,
      },
      {
        title: "Gallery",
        href: "/dashboard/gallery",
        icon: GalleryHorizontalEnd,
      },
      {
        title: "Generate",
        href: "/dashboard/generate",
        icon: Image,
      },
      {
        title: "Usage records",
        href: "/dashboard/history",
        icon: Clock,
      },
      {
        title: "API Docs",
        href: "/dashboard/api-docs",
        icon: BookOpen,
      },
      {
        title: "Models",
        href: "/models",
        icon: Layers,
      },
      {
        title: "API Keys",
        href: "/dashboard/external-api",
        icon: KeyRound,
      },
      {
        title: "Wallet",
        href: "/dashboard/wallet",
        icon: WalletCards,
      },
      {
        title: "Referrals",
        href: "/dashboard/referrals",
        icon: Share2,
      },
      {
        title: "Announcements",
        href: "/dashboard/announcements",
        icon: Megaphone,
      },
      {
        title: "Settings",
        href: "/dashboard/settings",
        icon: Settings,
      },
      {
        title: "Support",
        href: "/dashboard/support",
        icon: Headset,
      },
    ],
  },
];

// ============================================
// Admin 导航配置
// ============================================

/**
 * Admin 侧边栏导航分组
 */
export const adminNav: NavGroup[] = [
  {
    title: "Admin",
    items: [
      {
        title: "Dashboard",
        href: "/admin",
        icon: LayoutDashboard,
      },
      {
        title: "Users",
        href: "/admin/users",
        icon: Users,
      },
      {
        title: "Tickets",
        href: "/admin/tickets",
        icon: Ticket,
      },
    ],
  },
];

// ============================================
// 导出配置对象
// ============================================

/**
 * Marketing 页面配置
 */
export const marketingConfig = {
  mainNav,
  footerNav,
};

/**
 * Dashboard 页面配置
 */
export const dashboardConfig = {
  sidebarNav: dashboardNav,
};

/**
 * Admin 页面配置
 */
export const adminConfig = {
  sidebarNav: adminNav,
};
