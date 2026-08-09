/**
 * 用户数据看板首屏的 UOL 装配器。
 *
 * 使用方：数据看板 Server Component 与刷新 Server Action。模块只初始化 UOL、构造
 * 当前 user Principal 并调用单个整页 operation，不访问数据库或自行拼接指标。
 */
import type {
  DataDashboardInput,
  DataDashboardOutput,
} from "@repo/shared/analytics/contracts";
import type { AppUserRole } from "@repo/shared/auth/roles";
import { invokeOperation, type Principal } from "@repo/shared/uol";
import { ensureUolInitialized } from "@/server/uol-init";

/** 首屏与 action 共用的当前用户和未经二次解释的 strict 日期输入。 */
export type DataDashboardPageDataInput = {
  userId: string;
  role: AppUserRole;
  rangeInput: DataDashboardInput;
};

/** 可注入依赖让页面装配测试保持 DB-free。 */
export type DataDashboardPageDataDependencies = {
  ensureInitialized: () => Promise<void>;
  invokeDashboard: (
    input: DataDashboardInput,
    principal: Principal
  ) => Promise<DataDashboardOutput>;
};

/** 通过统一网关调用本人整页数据看板 operation。 */
async function invokeDashboardThroughUol(
  input: DataDashboardInput,
  principal: Principal
): Promise<DataDashboardOutput> {
  return invokeOperation<DataDashboardOutput>(
    "analytics.getMyDataDashboard",
    input,
    principal
  );
}

const defaultDependencies: DataDashboardPageDataDependencies = {
  ensureInitialized: ensureUolInitialized,
  invokeDashboard: invokeDashboardThroughUol,
};

/**
 * 加载当前用户同一日期范围的完整看板快照。
 *
 * @param input 当前 session 用户、角色和 strict 日期输入。
 * @param dependencies 可替换 UOL 初始化与调用端口。
 * @returns UOL 已验证的原子快照。
 * @throws operation 失败时原样上抛，调用方决定首屏不可用或 action 恢复状态。
 */
export async function loadDataDashboardPageData(
  input: DataDashboardPageDataInput,
  dependencies: DataDashboardPageDataDependencies = defaultDependencies
): Promise<DataDashboardOutput> {
  await dependencies.ensureInitialized();
  return dependencies.invokeDashboard(input.rangeInput, {
    type: "user",
    userId: input.userId,
    role: input.role,
  });
}
