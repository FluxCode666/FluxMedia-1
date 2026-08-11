/**
 * 用户端与管理端数据看板客户端原子快照状态纯逻辑。
 *
 * 使用方：DataDashboardPanel、AdminDataDashboardPanel 与 DB-free Vitest。模块不导入 React、Next 或 i18n，确保
 * 最新请求门禁与失败保留旧快照行为可被确定性验证。
 */
import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";

import type { DataDashboardActionResult } from "./actions";
import type { DataDashboardAppliedRange } from "./data-dashboard-query";

export type DataDashboardFailureStatus = Exclude<
  DataDashboardActionResult["status"],
  "ready"
> | null;
export type DataDashboardRequestStatus = "idle" | "loading" | "stale" | "error";

/** 客户端必须原子提交的快照、范围与状态集合。 */
export type DataDashboardViewState = {
  snapshot: DataDashboardOutput | null;
  appliedRange: DataDashboardAppliedRange | null;
  requestStatus: DataDashboardRequestStatus;
  failureStatus: DataDashboardFailureStatus;
};

/** 创建单调递增请求门禁，只允许最后发起的请求提交状态。 */
export function createDataDashboardRequestGate(): {
  begin: () => number;
  isLatest: (requestId: number) => boolean;
} {
  let latestRequestId = 0;
  return {
    begin() {
      latestRequestId += 1;
      return latestRequestId;
    },
    isLatest(requestId) {
      return requestId === latestRequestId;
    },
  };
}

/**
 * 把一个最新 action 结果应用到原子视图状态。
 *
 * @param current 最近状态。
 * @param result 已确认属于最新请求的安全 action 结果。
 * @returns 成功同时替换快照/范围；失败只标记 stale 或首次 error。
 */
export function applyDataDashboardActionResult(
  current: DataDashboardViewState,
  result: DataDashboardActionResult
): DataDashboardViewState {
  if (result.status === "ready") {
    return {
      snapshot: result.snapshot,
      appliedRange: {
        startDate: result.snapshot.range.startDate,
        endDate: result.snapshot.range.endDate,
      },
      requestStatus: "idle",
      failureStatus: null,
    };
  }
  return {
    ...current,
    requestStatus: current.snapshot ? "stale" : "error",
    failureStatus: result.status,
  };
}
