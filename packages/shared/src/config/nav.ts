/**
 * 全站导航配置与营销 Header 变体契约。
 *
 * 使用方：营销 Header、移动端 Sheet、Footer、Dashboard 与 Admin 侧栏。
 * 关键依赖：Lucide 图标；营销链接保持 locale-neutral，由应用层 i18n Link
 * 统一添加当前语言前缀。
 */
import {
  BookOpen,
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

/**
 * Products 下拉菜单项类型
 */
export interface ProductNavItem {
  title: string;
  href: string;
  description: string;
  icon: LucideIcon;
}

/**
 * Products 下拉菜单分组类型
 */
export interface ProductNavGroup {
  title: string;
  items: ProductNavItem[];
}

/** Marketing Header 支持的显式页面变体。 */
export type MarketingHeaderVariant = "home" | "marketing";

/** 桌面与移动端共同消费的营销 Header 导航快照。 */
export interface MarketingHeaderNavigation {
  items: readonly NavItem[];
  productGroups: readonly ProductNavGroup[];
}

// ============================================
// Marketing 导航配置
// ============================================

/**
 * Products 下拉菜单内容
 */
export const productsNav: ProductNavGroup[] = [
  {
    title: "Core features",
    items: [
      {
        title: "Chat to Image",
        href: "/dashboard",
        description: "Generate images from natural language",
        icon: Image,
      },
      {
        title: "Gallery",
        href: "/dashboard",
        description: "Browse and manage your creations",
        icon: GalleryHorizontalEnd,
      },
      {
        title: "Batch Generation",
        href: "/dashboard",
        description: "Generate multiple images at once",
        icon: Layers,
      },
    ],
  },
];

/**
 * 主导航链接 (Header)
 */
export const mainNav: NavItem[] = [
  { title: "Models", href: "/#models" },
  { title: "Quick Integration", href: "/#integration" },
  { title: "Work", href: "/#work" },
  { title: "Start Creating", href: "/#create" },
  { title: "Docs", href: "/api-docs" },
  { title: "Blog", href: "/blog" },
];

const emptyProductNav: readonly ProductNavGroup[] = [];

/**
 * 为指定页面变体返回营销 Header 的单一导航事实源。
 *
 * @param variant - 首页隐藏 Products 下拉，其他营销页面保留有效产品入口。
 * @returns 桌面 NavMenu 与移动 Sheet 必须共同使用的导航项和产品分组。
 * @sideEffects 无。
 */
export function getMarketingHeaderNavigation(
  variant: MarketingHeaderVariant
): MarketingHeaderNavigation {
  return {
    items: mainNav,
    productGroups: variant === "home" ? emptyProductNav : productsNav,
  };
}

/**
 * Footer 导航配置
 */
export const footerNav = {
  /** 产品 (Product) */
  product: [
    { title: "Docs", href: "/api-docs" },
    { title: "Contact Us", href: "mailto:support@media.flux-code.cc" },
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
        title: "Generate",
        href: "/dashboard/generate",
        icon: Image,
      },
      {
        title: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
      },
      {
        title: "Gallery",
        href: "/dashboard/gallery",
        icon: GalleryHorizontalEnd,
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
