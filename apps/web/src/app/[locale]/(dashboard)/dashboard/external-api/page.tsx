/**
 * API 密钥管理独立页面。
 *
 * 职责：校验登录会话、读取用户时区并渲染 API 密钥创建区与摘要列表。
 */
import { getServerSession } from "@repo/shared/auth/server";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { getCurrentDocumentationBaseUrl } from "@/features/docs/documentation-base-url-server";
import { ExternalApiKeySection } from "@/features/settings/components";

export const metadata = {
  title: "API Keys | FluxMedia",
  description: "Create and manage FluxMedia API keys",
};

/**
 * 渲染当前登录用户的 API 密钥管理页面。
 *
 * @returns 带用户时区的 API Key 管理区。
 * @sideEffects 读取会话、文档地址和用户时区；未登录时重定向。
 */
export default async function ExternalApiPage() {
  const [session, locale, baseUrl] = await Promise.all([
    getServerSession(),
    getLocale(),
    getCurrentDocumentationBaseUrl(),
  ]);
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const [t, timeZone] = await Promise.all([
    getTranslations("Settings.externalApi"),
    getUserTimeZone(session.user.id),
  ]);
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <ExternalApiKeySection baseUrl={baseUrl} timeZone={timeZone} />
    </div>
  );
}
