/**
 * 管理端全局数据看板首屏的 UOL 装配器。
 *
 * 使用方：`/dashboard/admin/analytics` 页面与刷新 Server Action。模块只负责初始化
 * UOL、构造管理员 Principal 并调用全局 operation，不读取数据库或自行拼接指标。
 */
import type {
  DataDashboardInput,
  DataDashboardOutput,
} from "@repo/shared/analytics/contracts";
import type { AppUserRole } from "@repo/shared/auth/roles";
import { invokeOperation, type Principal } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

/** 管理员首屏与 action 共用的 session 身份和 strict 日期输入。 */
export type AdminDataDashboardPageDataInput = {
  userId: string;
  role: AppUserRole;
  rangeInput: DataDashboardInput;
};

/** 可注入依赖让管理员首屏装配测试保持 DB-free。 */
export type AdminDataDashboardPageDataDependencies = {
  ensureInitialized: () => Promise<void>;
  invokeDashboard: (
    input: DataDashboardInput,
    principal: Principal
  ) => Promise<DataDashboardOutput>;
};

/** 通过统一接口层调用全站数据看板 operation。 */
async function invokeAdminDashboardThroughUol(
  input: DataDashboardInput,
  principal: Principal
): Promise<DataDashboardOutput> {
  return invokeOperation<DataDashboardOutput>(
    "analytics.getAdminDataDashboard",
    input,
    principal
  );
}

const defaultDependencies: AdminDataDashboardPageDataDependencies = {
  ensureInitialized: ensureUolInitialized,
  invokeDashboard: invokeAdminDashboardThroughUol,
};

/**
 * 加载管理员可见的全站数据看板快照。
 *
 * @param input 当前管理员 session、角色和 strict 日期输入。
 * @returns UOL 已验证的全站原子快照。
 * @throws operation 失败时原样上抛，由页面或 action 映射安全状态。
 */
export async function loadAdminDataDashboardPageData(
  input: AdminDataDashboardPageDataInput,
  dependencies: AdminDataDashboardPageDataDependencies = defaultDependencies
): Promise<DataDashboardOutput> {
  await dependencies.ensureInitialized();
  return dependencies.invokeDashboard(input.rangeInput, {
    type: "user",
    userId: input.userId,
    role: input.role,
  });
}
