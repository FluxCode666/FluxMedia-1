/**
 * 控制台内的外部 API 接入文档入口。
 *
 * 复用公开接入文档组件，但通过服务端会话守卫限定为已登录用户；管理员内部文档独立
 * 保留在 /docs/system。
 */
import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { ApiIntegrationDocs } from "@/features/docs/api-integration-docs";
import { getCurrentDocumentationBaseUrl } from "@/features/docs/documentation-base-url-server";

export const metadata = {
  title: "API Docs | FluxMedia",
  description:
    "FluxMedia external media API guide for models, credits, images, and videos",
};

/**
 * 渲染当前登录用户可见的控制台接入文档。
 *
 * @returns 复用公开内容源的模型、积分、图片与视频 API 文档；未登录时重定向到当前语言的登录页。
 * @sideEffects 读取服务端会话，失败边界交由控制台路由处理。
 */
export default async function DashboardApiDocsPage() {
  const [session, locale, baseUrl] = await Promise.all([
    getServerSession(),
    getLocale(),
    getCurrentDocumentationBaseUrl(),
  ]);

  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  return <ApiIntegrationDocs baseUrl={baseUrl} embedded locale={locale} />;
}
