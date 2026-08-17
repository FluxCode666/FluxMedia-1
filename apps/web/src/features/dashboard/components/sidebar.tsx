"use client";

import { getMyUnreadAnnouncementCountAction } from "@repo/shared/announcements/actions";
import { signOut } from "@repo/shared/auth/client";
import { normalizeUserRole } from "@repo/shared/auth/roles";
import { ModeToggle } from "@repo/shared/components";
import { dashboardConfig } from "@repo/shared/config";
import { CreditBalanceBadge } from "@repo/shared/credits/components";
import { getMyUnreadTicketCountAction } from "@repo/shared/support/actions/ticket";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/ui/components/avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/ui/components/popover";
import { Separator } from "@repo/ui/components/separator";
import { Sheet, SheetContent, SheetTitle } from "@repo/ui/components/sheet";
import { cn } from "@repo/ui/utils";
import {
  ChevronRight,
  ChevronsUpDown,
  Loader2,
  LogOut,
  Settings,
} from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import {
  type CurrentSession,
  useCurrentSession,
} from "@/features/auth/hooks/use-current-session";
import { SiteLogo } from "@/features/branding/site-logo";
import { useSidebar } from "@/features/dashboard/context";
import {
  buildAdministrationItems,
  findMostSpecificActiveHref,
  normalizeSidebarPath,
  type SidebarNavGroup,
} from "@/features/dashboard/sidebar-navigation";
import { requestNavigationFeedback } from "@/features/navigation/navigation-feedback-event";

/**
 * Dashboard 侧边栏组件
 *
 * 功能:
 * - 导航菜单 (从配置读取)
 * - 用户信息弹出菜单
 * - 主题切换
 * - 设置入口
 * - 登出功能
 * - 支持折叠/展开
 */
type DashboardSidebarProps = {
  initialSession?: CurrentSession;
};

/**
 * 显示由 Next.js Link 自身管理的目标路由 pending 状态。
 *
 * @param label 面向辅助技术的目标页面加载说明。
 * @param collapsed 是否处于仅图标侧栏，用于把状态固定到图标右上角。
 * @returns 当前 Link pending 时的旋转指示与读屏状态，空闲时不占布局。
 */
function SidebarLinkPendingIndicator({
  label,
  collapsed = false,
}: {
  label: string;
  collapsed?: boolean;
}) {
  const { pending } = useLinkStatus();
  if (!pending) return null;

  return (
    <span
      className={cn(
        "ml-auto inline-flex shrink-0",
        collapsed && "absolute right-1 top-1 ml-0"
      )}
      role="status"
    >
      <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function DashboardSidebar({ initialSession }: DashboardSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const { isCollapsed, isMobileOpen, setMobileOpen, toggleSidebar } =
    useSidebar();
  const t = useTranslations("Dashboard");
  const tNavigationFeedback = useTranslations("NavigationFeedback");

  // 获取当前用户会话
  const { data: session } = useCurrentSession(initialSession);
  const user = session?.user;
  const role = normalizeUserRole(user?.role);
  const isAdmin = role === "admin" || role === "super_admin";
  const isObserverAdmin = role === "observer_admin";
  const normalizedPathname = pathname.replace(/^\/[a-z]{2}\//, "/");
  const isRejectedAdminRoute =
    normalizedPathname.startsWith("/dashboard/admin/") &&
    !isAdmin &&
    !isObserverAdmin;

  // Popover 开关状态
  const [open, setOpen] = useState(false);
  const [expandedMenus, setExpandedMenus] = useState<Set<string>>(
    () => new Set()
  );

  const { execute: fetchUnreadTickets, result: unreadTicketsResult } =
    useAction(getMyUnreadTicketCountAction);
  const {
    execute: fetchUnreadAnnouncements,
    result: unreadAnnouncementsResult,
  } = useAction(getMyUnreadAnnouncementCountAction);
  const unreadTicketCount = Math.max(
    0,
    Number(unreadTicketsResult.data?.count ?? 0)
  );
  const unreadAnnouncementCount = Math.max(
    0,
    Number(unreadAnnouncementsResult.data?.count ?? 0)
  );

  useEffect(() => {
    // 子级 admin 守卫即将重定向普通用户；此时启动 Server Action 会与 RSC
    // 重定向竞争并触发无意义的 Router 更新，因此只在可停留页面读取侧栏数据。
    if (user && !isRejectedAdminRoute) {
      fetchUnreadTickets();
      fetchUnreadAnnouncements();
    }
  }, [
    user,
    isRejectedAdminRoute,
    fetchUnreadTickets,
    fetchUnreadAnnouncements,
  ]);

  /**
   * 导航项标题映射到翻译键
   */
  const getNavTitle = (title: string): string => {
    const titleMap: Record<string, string> = {
      Create: t("nav.create"),
      Generate: t("nav.generate"),
      Dashboard: t("nav.dashboard"),
      "Data dashboard": t("nav.analytics"),
      Gallery: t("nav.gallery"),
      "Usage records": t("nav.history"),
      "API Docs": t("nav.apiDocs"),
      Models: t("nav.models"),
      "API Keys": t("nav.externalApi"),
      Wallet: t("nav.wallet"),
      Referrals: t("nav.referrals"),
      Announcements: t("nav.announcements"),
      Settings: t("nav.settings"),
      "System Settings": t("nav.systemSettings"),
      "Global Status": t("nav.globalStatus"),
      "Admin Data Dashboard": t("nav.adminAnalytics"),
      "Operations Dashboard": t("nav.operations"),
      "Announcement Management": t("nav.announcementManagement"),
      "Model Configuration": t("nav.modelConfiguration"),
      "Supplier Management": t("nav.supplierManagement"),
      Support: t("nav.support"),
      "New Ticket": t("nav.newTicket"),
      "User Management": t("nav.userManagement"),
      "Global Usage Records": t("nav.globalUsageRecords"),
      "Payment Overview": t("nav.paymentOverview"),
      "Order Management": t("nav.orderManagement"),
      Administration: t("nav.administration"),
      User: t("nav.user"),
    };
    return titleMap[title] || title;
  };

  /**
   * 获取用户名首字母作为头像回退
   */
  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  /**
   * 处理登出
   */
  const handleSignOut = async () => {
    setOpen(false);
    await signOut({
      fetchOptions: {
        onSuccess: () => {
          requestNavigationFeedback("/");
          router.push("/");
        },
      },
    });
  };

  const localizedHref = (href: string) =>
    href.startsWith("/") ? `/${locale}${href}` : href;

  /**
   * 管理员先看系统管理入口，随后才是与普通用户相同的个人功能。
   *
   * WHY：菜单只负责发现性；真实页面和 Action 仍在服务端复查角色。普通用户继续完整
   * 保持 dashboardConfig 的原有分组和顺序，观察管理员只显示已获授权的管理功能。
   */
  const adminItems = buildAdministrationItems(role);
  const navigationGroups: SidebarNavGroup[] =
    adminItems.length === 0
      ? dashboardConfig.sidebarNav
      : [
          { title: "Administration", items: adminItems },
          {
            title: "User",
            items: dashboardConfig.sidebarNav.flatMap((group) => group.items),
          },
        ];

  /** 切换一级菜单展开状态；当前子路由激活时由渲染逻辑强制保持展开。 */
  const toggleExpandedMenu = (title: string): void => {
    setExpandedMenus((current) => {
      const next = new Set(current);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  };

  /**
   * 渲染侧边栏内容（桌面和移动端共用）
   * mobile 参数控制是否为移动端模式（始终展开，点击关闭）
   */
  const renderSidebarContent = (mobile: boolean) => {
    const collapsed = mobile ? false : isCollapsed;

    return (
      <>
        {/* 品牌区:px-5 与导航图标列(nav p-3 + item px-2.5)近似对齐,
            折叠态(w-16)下图标中心恰落在 20 + 12 = 32px,即侧栏水平中点 */}
        <div className="flex h-14 items-center px-5">
          <Link
            href={`/${locale}`}
            data-navigation-feedback={
              collapsed && !mobile ? "ignore" : undefined
            }
            className="relative flex items-center gap-2.5"
            onClick={(e) => {
              if (mobile) {
                setMobileOpen(false);
              } else if (collapsed) {
                e.preventDefault();
                toggleSidebar();
              }
            }}
          >
            <SiteLogo size={24} className="shrink-0" alt="" />
            <span
              className={cn(
                "font-serif text-lg font-medium tracking-tight transition-opacity duration-150",
                collapsed && "opacity-0"
              )}
            >
              FluxMedia
            </span>
            <SidebarLinkPendingIndicator
              collapsed={collapsed}
              label={tNavigationFeedback("opening", { page: "FluxMedia" })}
            />
          </Link>
        </div>

        {/* 导航菜单 */}
        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          {navigationGroups.map((group) => (
            <div key={group.title}>
              {/* Group Label - 折叠时隐藏 */}
              {!collapsed && (
                <p className="mb-2 px-2.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground/70">
                  {getNavTitle(group.title)}
                </p>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  // 去掉 locale 前缀后比较路径
                  const normalizedPath = normalizeSidebarPath(pathname);
                  const activeChildHref = item.items
                    ? findMostSpecificActiveHref(pathname, item.items)
                    : null;
                  const isActive =
                    Boolean(activeChildHref) ||
                    normalizedPath === item.href ||
                    (!item.items &&
                      item.href !== "/dashboard" &&
                      normalizedPath.startsWith(`${item.href}/`));
                  const Icon = item.icon;
                  const translatedTitle = getNavTitle(item.title);
                  const showSupportUnread =
                    item.href === "/dashboard/support" && unreadTicketCount > 0;
                  const unreadCount =
                    item.href === "/dashboard/announcements"
                      ? unreadAnnouncementCount
                      : showSupportUnread
                        ? unreadTicketCount
                        : 0;
                  const showUnread = unreadCount > 0;

                  if (item.items) {
                    const isExpanded =
                      Boolean(activeChildHref) || expandedMenus.has(item.title);
                    return (
                      <div key={item.title}>
                        <button
                          aria-expanded={!collapsed && isExpanded}
                          className={cn(
                            "relative flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-150",
                            isActive
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                            collapsed && "justify-center px-0"
                          )}
                          onClick={() => {
                            if (collapsed && !mobile) {
                              toggleSidebar();
                              setExpandedMenus((current) =>
                                new Set(current).add(item.title)
                              );
                              return;
                            }
                            toggleExpandedMenu(item.title);
                          }}
                          title={collapsed ? translatedTitle : undefined}
                          type="button"
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground transition-[opacity,scale] duration-200",
                              isActive
                                ? "scale-y-100 opacity-100"
                                : "scale-y-50 opacity-0"
                            )}
                          />
                          {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                          {!collapsed ? (
                            <>
                              <span className="flex-1 text-left">
                                {translatedTitle}
                              </span>
                              <ChevronRight
                                className={cn(
                                  "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                                  isExpanded && "rotate-90"
                                )}
                              />
                            </>
                          ) : null}
                        </button>

                        {!collapsed && isExpanded ? (
                          <div className="ml-[18px] mt-1 space-y-0.5 border-l border-sidebar-border/70 pl-3">
                            {item.items.map((child) => {
                              const ChildIcon = child.icon;
                              const childActive =
                                child.href === activeChildHref;
                              return (
                                <Link
                                  className={cn(
                                    "relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150",
                                    childActive
                                      ? "bg-sidebar-accent/80 font-medium text-sidebar-accent-foreground"
                                      : "text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                                  )}
                                  href={localizedHref(child.href)}
                                  key={child.href}
                                  onClick={() => mobile && setMobileOpen(false)}
                                >
                                  <span
                                    aria-hidden="true"
                                    className={cn(
                                      "absolute -left-[14px] size-1.5 rounded-full border border-sidebar-border bg-sidebar transition-colors",
                                      childActive &&
                                        "border-foreground bg-foreground"
                                    )}
                                  />
                                  {ChildIcon ? (
                                    <ChildIcon className="size-3.5 shrink-0" />
                                  ) : null}
                                  <span>{getNavTitle(child.title)}</span>
                                  <SidebarLinkPendingIndicator
                                    label={tNavigationFeedback("opening", {
                                      page: getNavTitle(child.title),
                                    })}
                                  />
                                </Link>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  }

                  return (
                    <Link
                      key={item.href}
                      href={localizedHref(item.href)}
                      title={collapsed ? translatedTitle : undefined}
                      onClick={() => mobile && setMobileOpen(false)}
                      className={cn(
                        // 激活/hover 均取 sidebar 专属 token:侧栏底色与 secondary/muted
                        // 同值,通用灰阶在此不可见,sidebar-accent 才能在明暗两态浮出
                        "relative flex items-center gap-3 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-150",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                        collapsed && "justify-center px-0"
                      )}
                    >
                      {/* 激活指示竖线:淡入 + 纵向展开;非激活时保留元素,靠 opacity/scale 过渡 */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground transition-[opacity,scale] duration-200",
                          isActive
                            ? "scale-y-100 opacity-100"
                            : "scale-y-50 opacity-0"
                        )}
                      />
                      {Icon && (
                        <span className="relative inline-flex shrink-0">
                          <Icon className="h-4 w-4" />
                          {showUnread && (
                            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive ring-2 ring-sidebar" />
                          )}
                        </span>
                      )}
                      {!collapsed && (
                        <>
                          <span className="flex-1">{translatedTitle}</span>
                          {showUnread && (
                            <span className="min-w-5 rounded-full bg-destructive px-1.5 py-0.5 text-center text-[10px] font-medium leading-none text-white">
                              {unreadCount > 99 ? "99+" : unreadCount}
                            </span>
                          )}
                        </>
                      )}
                      <SidebarLinkPendingIndicator
                        collapsed={collapsed}
                        label={tNavigationFeedback("opening", {
                          page: translatedTitle,
                        })}
                      />
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* 用户信息区域 */}
        <div
          className="border-t border-sidebar-border p-3"
          key={user?.id || "session-loading"}
        >
          {user ? (
            <Popover key={user.id} open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    // 卡片化用户区:细边框 + 轻底色,hover 同步提亮边框与底色;
                    // 折叠态空间不足,退化为无边框纯图标
                    "flex w-full items-center gap-3 rounded-md border border-sidebar-border/60 bg-sidebar-accent/20 px-2.5 py-2 transition-colors duration-200 hover:border-sidebar-border hover:bg-sidebar-accent/50",
                    collapsed &&
                      "justify-center border-transparent bg-transparent px-0 hover:border-transparent"
                  )}
                >
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarImage
                      key={user.image || user.id}
                      src={user.image || undefined}
                      alt={user.name}
                    />
                    <AvatarFallback className="bg-foreground text-background text-xs">
                      {getInitials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  {!collapsed && (
                    <>
                      <div className="min-w-0 flex-1 text-left">
                        {/* 名字可截断,积分徽章 shrink-0 防止长用户名将其挤出可视区 */}
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">
                            {user.name}
                          </p>
                          <span className="shrink-0">
                            {isRejectedAdminRoute ? null : (
                              <CreditBalanceBadge key={user.id} />
                            )}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {user.email}
                        </p>
                      </div>
                      <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </>
                  )}
                </button>
              </PopoverTrigger>

              <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-64 p-0"
              >
                {/* 用户信息头部 */}
                <div className="flex items-center gap-3 p-4">
                  <Avatar className="h-10 w-10">
                    <AvatarImage
                      key={user.image || user.id}
                      src={user.image || undefined}
                      alt={user.name}
                    />
                    <AvatarFallback className="bg-foreground text-background">
                      {getInitials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{user.name}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {user.email}
                    </p>
                  </div>
                </div>

                <Separator />

                {/* 主题切换 - 使用共享 ModeToggle 组件 */}
                <div className="flex items-center justify-center p-3">
                  <ModeToggle variant="inline" />
                </div>

                <Separator />

                {/* 菜单项 */}
                <div className="p-2">
                  {/* 设置 */}
                  <Link
                    href={`/${locale}/dashboard/settings`}
                    onClick={() => setOpen(false)}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors duration-150"
                  >
                    <Settings className="h-4 w-4" />
                    {t("sidebar.settings")}
                    <SidebarLinkPendingIndicator
                      label={tNavigationFeedback("opening", {
                        page: t("sidebar.settings"),
                      })}
                    />
                  </Link>

                  {/* 登出 */}
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors duration-150"
                  >
                    <LogOut className="h-4 w-4" />
                    {t("sidebar.logout")}
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            // 加载状态
            <div
              className={cn(
                "flex items-center gap-3 rounded-md border border-sidebar-border/60 px-2.5 py-2",
                collapsed && "justify-center border-transparent px-0"
              )}
            >
              <div className="h-8 w-8 animate-pulse rounded-full bg-sidebar-accent shrink-0" />
              {!collapsed && (
                <div className="flex-1 space-y-1">
                  <div className="h-4 w-20 animate-pulse rounded bg-sidebar-accent" />
                  <div className="h-3 w-32 animate-pulse rounded bg-sidebar-accent" />
                </div>
              )}
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <>
      {/* 桌面端侧边栏 */}
      <aside
        className={cn(
          // 仅过渡宽度,避免 transition-all 连带过渡颜色等无关属性
          "fixed left-0 top-0 z-40 hidden h-screen flex-col bg-sidebar border-r border-sidebar-border transition-[width] duration-300 md:flex",
          isCollapsed ? "w-16" : "w-64"
        )}
      >
        {renderSidebarContent(false)}
      </aside>

      {/* 移动端 Sheet 侧边栏 */}
      <Sheet open={isMobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-64 bg-sidebar p-0 md:hidden [&>button:last-child]:hidden"
        >
          <SheetTitle className="sr-only">{t("nav.dashboard")}</SheetTitle>
          <div className="flex h-full flex-col">
            {renderSidebarContent(true)}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
