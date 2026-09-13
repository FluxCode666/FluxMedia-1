import "fumadocs-ui/style.css";

import { canAccessAdminArea, normalizeUserRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { Header } from "@/features/marketing/components";
import { docsSource } from "@/lib/source";

/**
 * 管理员文档布局。
 *
 * 在渲染 Fumadocs 页面树前使用会话中的角色做集中式授权。未登录用户前往登录页，
 * 已登录普通用户前往公开 API 接入文档，避免任何 /docs 子页因新增路由而绕过保护。
 *
 * @param children - 管理员文档子页面。
 * @param params - 包含当前 locale 的路由参数。
 * @returns 通过授权后的 Fumadocs 布局。
 * @sideEffects 授权失败时调用 redirect，中止当前渲染。
 */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const [{ locale }, session] = await Promise.all([params, getServerSession()]);
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = normalizeUserRole((session.user as { role?: string | null }).role);
  if (!canAccessAdminArea(role)) {
    redirect(`/${locale}/api-docs`);
  }

  // 获取页面树（不需要 locale，因为 i18n 由 Next.js 路由处理）
  const tree = docsSource.pageTree;

  return (
    // RootProvider 仅在文档区挂载(全局 Providers 已不再挂载它),提供 fumadocs 的
    // 搜索/page-tree 等上下文;fumadocs-ui/style.css 同理只在文档区引入。
    <RootProvider>
      {/* 网站顶部导航栏 - 放在 DocsLayout 外部确保显示 */}
      <Header />

      {/* Fumadocs 文档布局 */}
      <DocsLayout
        tree={tree}
        nav={{
          enabled: false, // 禁用 Fumadocs 自带的顶部导航
        }}
        sidebar={{
          defaultOpenLevel: 1,
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
