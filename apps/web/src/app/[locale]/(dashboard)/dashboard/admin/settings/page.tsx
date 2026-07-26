import { getUserRoleById } from "@repo/shared/auth/role-server";
import {
  canAccessAdminArea,
  canManageUserPermissions,
  canViewImageBackendPool,
} from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
/**
 * 管理员设置页的服务端会话、角色与时区装配入口。
 *
 * 使用方是本地化 dashboard 路由；页面先读取实时角色，再把系统设置、模型配置和后端池的
 * 细分能力交给客户端页签。真实读写仍由各 Action/UOL 重复授权。
 */
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { AdminSettingsTabs } from "./admin-settings-tabs";

/**
 * 渲染当前后台角色允许进入的设置页签。
 *
 * @returns 已登录 observer/admin/super_admin 的设置页；未登录或普通用户重定向。
 * @sideEffects 读取会话、实时角色和用户时区；不执行设置写入。
 * @failure 会话缺失跳转登录，非后台角色跳转 dashboard；读取异常交给路由错误边界。
 */
export default async function DashboardAdminSettingsPage() {
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canViewImageBackendPool(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const timeZone = await getUserTimeZone(session.user.id);

  // 系统设置面板可写入 BETTER_AUTH_SECRET 等密钥，必须限制为超管，
  // 否则普通 admin 可改写认证密钥伪造会话实现账号接管（见审计 S-C1）。
  return (
    <AdminSettingsTabs
      timeZone={timeZone}
      canManageSystemSettings={canManageUserPermissions(role)}
      canViewModelConfiguration={
        canAccessAdminArea(role) || role === "observer_admin"
      }
      imageBackendPoolReadOnly={!canAccessAdminArea(role)}
    />
  );
}
