/**
 * 控制台支持配置的数据装配器。
 *
 * 页面只通过 UOL 读取允许展示的支持字段与公告预览。本模块把这些读取视为可选服务：
 * UOL、数据库或缓存暂不可用时记录脱敏错误并返回安全默认值，不拖垮账户与用量主体。
 */
import type { AppUserRole } from "@repo/shared/auth/roles";
import { logError } from "@repo/shared/logger";
import {
  type DashboardSupportConfig,
  DEFAULT_DASHBOARD_SUPPORT_CONFIG,
} from "@repo/shared/support/dashboard-config";
import { ensureUolInitialized } from "@/server/uol-init";

/** Dashboard 右侧公告卡所需的最小只读字段。 */
export type DashboardAnnouncement = {
  id: string;
  title: string;
  content: string;
  publishedAt: string;
  isRead: boolean;
};

type DashboardSupportDependencies = {
  ensureInitialized: () => Promise<void>;
  loadConfiguration: (input: {
    userId: string;
    role: AppUserRole;
  }) => Promise<DashboardSupportConfig>;
  reportFailure: () => void;
};

type DashboardAnnouncementsDependencies = {
  ensureInitialized: () => Promise<void>;
  loadAnnouncements: (input: {
    userId: string;
    role: AppUserRole;
  }) => Promise<DashboardAnnouncement[]>;
  reportFailure: () => void;
};

/** 通过统一操作层读取当前登录用户可见的支持配置。 */
async function loadConfigurationThroughUol(input: {
  userId: string;
  role: AppUserRole;
}): Promise<DashboardSupportConfig> {
  const { invokeOperation } = await import("@repo/shared/uol");
  return invokeOperation<DashboardSupportConfig>(
    "support.getDashboardConfiguration",
    {},
    { type: "user", userId: input.userId, role: input.role }
  );
}

/** 通过统一操作层读取当前登录用户可见的最新公告。 */
async function loadAnnouncementsThroughUol(input: {
  userId: string;
  role: AppUserRole;
}): Promise<DashboardAnnouncement[]> {
  const { invokeOperation } = await import("@repo/shared/uol");
  const result = await invokeOperation<{
    announcements: DashboardAnnouncement[];
  }>(
    "support.listAnnouncements",
    { page: 1, pageSize: 3 },
    { type: "user", userId: input.userId, role: input.role }
  );
  return result.announcements;
}

/** 记录不包含数据库错误、配置正文或用户标识的降级事件。 */
function reportDashboardSupportFailure(): void {
  logError(new Error("Dashboard support data is unavailable"), {
    source: "dashboard-support-data",
  });
}

const defaultDependencies: DashboardSupportDependencies = {
  ensureInitialized: ensureUolInitialized,
  loadConfiguration: loadConfigurationThroughUol,
  reportFailure: reportDashboardSupportFailure,
};

const defaultAnnouncementsDependencies: DashboardAnnouncementsDependencies = {
  ensureInitialized: ensureUolInitialized,
  loadAnnouncements: loadAnnouncementsThroughUol,
  reportFailure: reportDashboardSupportFailure,
};

/**
 * 加载控制台支持配置并在可选依赖失败时安全降级。
 *
 * @param input 当前用户 ID 与服务端查得的角色。
 * @param dependencies 可替换依赖，仅用于 DB-free 单元测试。
 * @returns 已校验的支持配置；失败时返回安全默认配置。
 */
export async function loadDashboardSupportConfiguration(
  input: { userId: string; role: AppUserRole },
  dependencies: DashboardSupportDependencies = defaultDependencies
): Promise<DashboardSupportConfig> {
  try {
    await dependencies.ensureInitialized();
    return await dependencies.loadConfiguration(input);
  } catch {
    dependencies.reportFailure();
    return DEFAULT_DASHBOARD_SUPPORT_CONFIG;
  }
}

/**
 * 加载 Dashboard 右侧展示的前三条公告；公告读取失败不影响账户与用量主体。
 *
 * @param input 当前用户 ID 与服务端查得的角色。
 * @param dependencies 可替换依赖，仅用于 DB-free 单元测试。
 * @returns 已发布公告的预览数组；失败时返回空数组。
 */
export async function loadDashboardAnnouncements(
  input: { userId: string; role: AppUserRole },
  dependencies: DashboardAnnouncementsDependencies = defaultAnnouncementsDependencies
): Promise<DashboardAnnouncement[]> {
  try {
    await dependencies.ensureInitialized();
    return await dependencies.loadAnnouncements(input);
  } catch {
    dependencies.reportFailure();
    return [];
  }
}
