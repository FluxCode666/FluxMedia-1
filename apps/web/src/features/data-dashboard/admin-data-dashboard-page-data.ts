/**
 * 管理端数据看板首屏的 UOL 装配器。
 *
 * 使用方：`/dashboard/admin/analytics` 页面与刷新 Server Action。模块只负责初始化
 * UOL、构造管理员 Principal 并调用看板/用户搜索 operation，不读取数据库或自行拼接指标。
 */
import type {
  AdminDataDashboardInput,
  AdminDataDashboardUserOption,
  DataDashboardOutput,
} from "@repo/shared/analytics/contracts";
import type { AppUserRole } from "@repo/shared/auth/roles";
import { invokeOperation, type Principal } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

/** 管理员首屏与 action 共用的 session 身份和 strict 日期输入。 */
export type AdminDataDashboardPageDataInput = {
  userId: string;
  role: AppUserRole;
  rangeInput: AdminDataDashboardInput;
};

export type AdminDataDashboardPageData = {
  snapshot: DataDashboardOutput | null;
  selectedUser: AdminDataDashboardUserOption | null;
  invalidSelectedUser: boolean;
  loadError: unknown | null;
};

/** 可注入依赖让管理员首屏装配测试保持 DB-free。 */
export type AdminDataDashboardPageDataDependencies = {
  ensureInitialized: () => Promise<void>;
  invokeDashboard: (
    input: AdminDataDashboardInput,
    principal: Principal
  ) => Promise<DataDashboardOutput>;
  searchUsers: (
    input: { query: string; limit: number; selectedUserId?: string },
    principal: Principal
  ) => Promise<{ users: AdminDataDashboardUserOption[] }>;
};

/** 通过统一接口层调用全站或指定用户的数据看板 operation。 */
async function invokeAdminDashboardThroughUol(
  input: AdminDataDashboardInput,
  principal: Principal
): Promise<DataDashboardOutput> {
  return invokeOperation<DataDashboardOutput>(
    "analytics.getAdminDataDashboard",
    input,
    principal
  );
}

/** 通过统一接口层查询首屏已选用户的显示信息。 */
async function searchAdminDashboardUsersThroughUol(
  input: { query: string; limit: number; selectedUserId?: string },
  principal: Principal
): Promise<{ users: AdminDataDashboardUserOption[] }> {
  return invokeOperation<{ users: AdminDataDashboardUserOption[] }>(
    "analytics.searchAdminDataDashboardUsers",
    input,
    principal
  );
}

const defaultDependencies: AdminDataDashboardPageDataDependencies = {
  ensureInitialized: ensureUolInitialized,
  invokeDashboard: invokeAdminDashboardThroughUol,
  searchUsers: searchAdminDashboardUsersThroughUol,
};

/**
 * 加载管理员可见的全站或指定用户数据看板快照。
 *
 * @param input 当前管理员 session、角色和 strict 日期输入。
 * @returns 看板快照、可选用户信息、无效用户标记和可映射的加载错误。
 * @throws UOL 初始化或用户显示信息查询失败时原样上抛。
 */
export async function loadAdminDataDashboardPageData(
  input: AdminDataDashboardPageDataInput,
  dependencies: AdminDataDashboardPageDataDependencies = defaultDependencies
): Promise<AdminDataDashboardPageData> {
  await dependencies.ensureInitialized();
  const principal: Principal = {
    type: "user",
    userId: input.userId,
    role: input.role,
  };
  const selectedUserId =
    "userId" in input.rangeInput ? input.rangeInput.userId : undefined;
  let dashboardInput = input.rangeInput;
  let selectedUser: AdminDataDashboardUserOption | null = null;
  let invalidSelectedUser = false;
  if (selectedUserId) {
    const result = await dependencies.searchUsers(
      { query: "", limit: 1, selectedUserId },
      principal
    );
    selectedUser = result.users[0] ?? null;
    if (!selectedUser) {
      const { userId: _invalidUserId, ...rangeInput } = input.rangeInput;
      dashboardInput = rangeInput;
      invalidSelectedUser = true;
    }
  }
  try {
    return {
      snapshot: await dependencies.invokeDashboard(dashboardInput, principal),
      selectedUser,
      invalidSelectedUser,
      loadError: null,
    };
  } catch (loadError) {
    return {
      snapshot: null,
      selectedUser,
      invalidSelectedUser,
      loadError,
    };
  }
}
