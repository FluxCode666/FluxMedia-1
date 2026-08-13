/**
 * 运营总览首屏 Server Component 数据装配。
 *
 * 使用方：`/dashboard/admin/operations`。页面只通过 UOL 读取一致 overview 和当前
 * 管理员的导出记录，不在路由层复制运营 SQL、权限判断或错误详情。
 */
import type { AppUserRole } from "@repo/shared/auth/roles";
import { isAdminRole } from "@repo/shared/auth/roles";
import type {
  OperationsDashboardQueryInput,
  OperationsExportTask,
} from "@repo/shared/operations-dashboard/contracts";
import {
  invokeOperation,
  OperationError,
  type Principal,
} from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

import type { OperationsDashboardOverview } from "./operations-dashboard-service";

export type OperationsDashboardLoadFailure =
  | "validation_error"
  | "not_ready"
  | "rate_limited"
  | "timeout"
  | "unavailable";

export type OperationsDashboardPageData = {
  overview: OperationsDashboardOverview | null;
  exports: OperationsExportTask[];
  exportsNextCursor: string | null;
  loadError: OperationsDashboardLoadFailure | null;
  exportsLoadError: OperationsDashboardLoadFailure | null;
};

/** 可注入依赖让首屏权限和部分失败行为保持 DB-free 可测试。 */
export type OperationsDashboardPageDataDependencies = {
  ensureInitialized: () => Promise<void>;
  invokeOverview: (
    input: OperationsDashboardQueryInput,
    principal: Principal
  ) => Promise<OperationsDashboardOverview>;
  listExports: (
    input: { limit: number },
    principal: Principal
  ) => Promise<{ tasks: OperationsExportTask[]; nextCursor: string | null }>;
};

/** 通过统一接口层读取运营总览快照。 */
async function invokeOverviewThroughUol(
  input: OperationsDashboardQueryInput,
  principal: Principal
): Promise<OperationsDashboardOverview> {
  return invokeOperation<OperationsDashboardOverview>(
    "operations.getOverview",
    input,
    principal
  );
}

/** 通过统一接口层读取当前管理员的导出记录。 */
async function listExportsThroughUol(
  input: { limit: number },
  principal: Principal
): Promise<{ tasks: OperationsExportTask[]; nextCursor: string | null }> {
  return invokeOperation<{
    tasks: OperationsExportTask[];
    nextCursor: string | null;
  }>("operations.listExports", input, principal);
}

const defaultDependencies: OperationsDashboardPageDataDependencies = {
  ensureInitialized: ensureUolInitialized,
  invokeOverview: invokeOverviewThroughUol,
  listExports: listExportsThroughUol,
};

/** 将内部 operation 异常映射为不泄露 SQL、身份或存储信息的页面状态。 */
function mapPageLoadError(error: unknown): OperationsDashboardLoadFailure {
  if (!(error instanceof OperationError)) return "unavailable";
  switch (error.code) {
    case "validation_error":
    case "not_ready":
    case "rate_limited":
    case "timeout":
      return error.code;
    default:
      return "unavailable";
  }
}

/**
 * 从 UOL 并行读取 overview 与导出记录。
 *
 * @param input 当前管理员 session、角色和已验证查询。
 * @param dependencies 可替换的 UOL 初始化与读取函数。
 * @returns 两个读取结果及各自安全失败状态；导出失败不会遮蔽运营快照。
 * @throws 非 admin/super_admin 身份在初始化前以 forbidden 拒绝。
 */
export async function loadOperationsDashboardPageData(
  input: {
    userId: string;
    role: AppUserRole;
    query: OperationsDashboardQueryInput;
  },
  dependencies: OperationsDashboardPageDataDependencies = defaultDependencies
): Promise<OperationsDashboardPageData> {
  if (!isAdminRole(input.role)) {
    throw new OperationError("forbidden", "仅管理员可读取运营总览");
  }

  try {
    await dependencies.ensureInitialized();
  } catch (error) {
    return {
      overview: null,
      exports: [],
      exportsNextCursor: null,
      loadError: mapPageLoadError(error),
      exportsLoadError: mapPageLoadError(error),
    };
  }

  const principal: Principal = {
    type: "user",
    userId: input.userId,
    role: input.role,
  };
  const [overviewResult, exportsResult] = await Promise.allSettled([
    dependencies.invokeOverview(input.query, principal),
    dependencies.listExports({ limit: 20 }, principal),
  ]);

  return {
    overview:
      overviewResult.status === "fulfilled" ? overviewResult.value : null,
    exports:
      exportsResult.status === "fulfilled" ? exportsResult.value.tasks : [],
    exportsNextCursor:
      exportsResult.status === "fulfilled"
        ? exportsResult.value.nextCursor
        : null,
    loadError:
      overviewResult.status === "rejected"
        ? mapPageLoadError(overviewResult.reason)
        : null,
    exportsLoadError:
      exportsResult.status === "rejected"
        ? mapPageLoadError(exportsResult.reason)
        : null,
  };
}
