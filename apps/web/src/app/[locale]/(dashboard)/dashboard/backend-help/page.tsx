/**
 * 已移除的控制台系统文档兼容入口。
 *
 * 使用方：仍保存旧 /dashboard/backend-help 地址的管理员书签。系统文档不再作为控制台
 * 页面展示，旧地址统一转到当前用户 API 文档，避免留下可访问的重复文档或 404。
 */
import { redirect } from "next/navigation";

/**
 * 将旧系统文档地址永久收敛到控制台 API 文档。
 *
 * @param params - 当前国际化路由参数。
 * @returns 不返回页面内容；Next.js redirect 会中止当前渲染。
 * @sideEffects 抛出 Next.js 重定向控制流，不读取会话或数据库。
 */
export default async function LegacyBackendHelpPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/dashboard/api-docs`);
}
