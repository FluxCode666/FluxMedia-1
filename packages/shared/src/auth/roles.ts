export const APP_USER_ROLES = [
  "user",
  "observer_admin",
  "admin",
  "super_admin",
] as const;

export type AppUserRole = (typeof APP_USER_ROLES)[number];

export const ADMIN_MANAGEMENT_ROLES = ["admin", "super_admin"] as const;
export const IMAGE_BACKEND_POOL_VIEWER_ROLES = [
  "observer_admin",
  "admin",
  "super_admin",
] as const;
export const GLOBAL_USAGE_RECORDS_VIEWER_ROLES = [
  "observer_admin",
  "admin",
  "super_admin",
] as const;

export function normalizeUserRole(role?: string | null): AppUserRole {
  return APP_USER_ROLES.includes(role as AppUserRole)
    ? (role as AppUserRole)
    : "user";
}

export function isSuperAdminRole(role?: string | null) {
  return normalizeUserRole(role) === "super_admin";
}

export function isObserverAdminRole(role?: string | null) {
  return normalizeUserRole(role) === "observer_admin";
}

export function isAdminRole(role?: string | null) {
  const normalized = normalizeUserRole(role);
  return normalized === "admin" || normalized === "super_admin";
}

export function canAccessAdminArea(role?: string | null) {
  return isAdminRole(role);
}

export function canViewImageBackendPool(role?: string | null) {
  return IMAGE_BACKEND_POOL_VIEWER_ROLES.includes(
    normalizeUserRole(role) as (typeof IMAGE_BACKEND_POOL_VIEWER_ROLES)[number]
  );
}

/** 判断角色能否查看全局生成历史及其中的实际视频输入。 */
export function canViewGlobalUsageRecords(role?: string | null) {
  return GLOBAL_USAGE_RECORDS_VIEWER_ROLES.includes(
    normalizeUserRole(
      role
    ) as (typeof GLOBAL_USAGE_RECORDS_VIEWER_ROLES)[number]
  );
}

export function canManageUserPermissions(role?: string | null) {
  return isSuperAdminRole(role);
}

/**
 * 高敏用户管理操作（封禁、积分发放等）的目标权限护栏。
 *
 * 规则：超管可操作任意账户；非超管仅能操作"权限等级严格低于自己"的账户。
 * APP_USER_ROLES 为升序（user < observer_admin < admin < super_admin），index 即等级。
 * 用于防止普通 admin 封禁/锁死 super_admin 或越级互操作（审计 S-H5）。
 */
export function canActOnTargetRole(
  actorRole?: string | null,
  targetRole?: string | null
) {
  if (isSuperAdminRole(actorRole)) return true;
  const actorRank = APP_USER_ROLES.indexOf(normalizeUserRole(actorRole));
  const targetRank = APP_USER_ROLES.indexOf(normalizeUserRole(targetRole));
  return targetRank < actorRank;
}

export function getUserRoleLabel(role?: string | null) {
  switch (normalizeUserRole(role)) {
    case "super_admin":
      return "超管";
    case "admin":
      return "管理员";
    case "observer_admin":
      return "观察管理员";
    case "user":
    default:
      return "普通用户";
  }
}
