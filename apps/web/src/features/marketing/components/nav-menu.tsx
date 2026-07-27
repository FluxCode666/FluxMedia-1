/**
 * 营销 Header 的桌面导航菜单。
 *
 * 使用方：`header.tsx`；导航数据由 Header 同时传给本组件与移动 Sheet。
 * 关键依赖：next-intl 路由、NavigationMenu 与 Framer Motion 悬停反馈。
 */
"use client";

import type { NavItem } from "@repo/shared/config";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "@repo/ui/components/navigation-menu";
import { cn } from "@repo/ui/utils";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Link, usePathname } from "@/i18n/routing";

/**
 * 导航菜单组件。
 *
 * @param items - 与移动 Sheet 共用的营销导航项。
 * @returns 可键盘到达并标识当前路由的桌面导航。
 * @sideEffects 管理悬停状态。
 */
export function NavMenu({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  const t = useTranslations("Navigation");
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  const navTitleMap: Record<string, string> = {
    Models: t("models"),
    Docs: t("docs"),
  };

  /** 判断链接是否命中当前本地化路由。 */
  const isActive = (href: string) => {
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <NavigationMenu onMouseLeave={() => setHoveredItem(null)}>
      <NavigationMenuList className="gap-0">
        {/* 普通导航链接 */}
        {items.map((item) => {
          const active = isActive(item.href);
          return (
            <NavigationMenuItem key={item.href}>
              <NavigationMenuLink asChild>
                <Link
                  href={item.href}
                  onMouseEnter={() => setHoveredItem(item.href)}
                  className={cn(
                    "relative inline-flex h-9 items-center justify-center px-4 py-2 text-sm font-medium transition-colors",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {hoveredItem === item.href && (
                    <motion.span
                      layoutId="nav-pill"
                      className="absolute inset-0 -z-10 rounded-md bg-muted"
                      transition={{
                        type: "spring",
                        bounce: 0,
                        duration: 0.3,
                      }}
                    />
                  )}
                  {/* 当前路由静态底色:无动画诉求,用普通元素即可 */}
                  {active && !hoveredItem && (
                    <span className="absolute inset-0 -z-10 rounded-md bg-muted/50" />
                  )}
                  {navTitleMap[item.title] || item.title}
                </Link>
              </NavigationMenuLink>
            </NavigationMenuItem>
          );
        })}
      </NavigationMenuList>
    </NavigationMenu>
  );
}
