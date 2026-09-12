import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { SettingsProfileView } from "@/features/settings/components";
import { requestGoJson } from "@/server/go-backend-client";

/**
 * 设置页面元数据
 */
export const metadata = {
  title: "Settings | FluxMedia",
  description: "Manage your account settings and preferences",
};

/**
 * 用户设置页面
 *
 * Server Component - 在服务端获取用户数据
 * 将数据传递给客户端 SettingsProfileView 组件
 */
export default async function SettingsPage() {
  // 获取当前用户会话
  const session = await getServerSession();
  const locale = await getLocale();

  // 如果用户未登录，重定向到登录页
  if (!session || !session.user) {
    redirect(`/${locale}/sign-in`);
  }

  const profile = await requestGoJson<{
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    timeZone: string | null;
    defaultTimeZone: string;
  }>("/api/user/profile");

  return (
    <SettingsProfileView
      user={{
        id: session.user.id,
        name: (profile.name ?? session.user.name) || "",
        email: (profile.email ?? session.user.email) || "",
        image: profile.image ?? session.user.image,
        timeZone: profile.timeZone?.trim() || null,
        defaultTimeZone: profile.defaultTimeZone,
      }}
    />
  );
}
