/**
 * 运营总览客户端快照状态机。
 *
 * 使用方：OperationsDashboardPanel 与 DB-free Vitest。模块保证只有最新请求可替换
 * 完整快照；刷新失败时保留旧快照和已应用查询，避免把部分或过期数据伪装成成功。
 */
import type { OperationsDashboardQueryInput } from "@repo/shared/operations-dashboard/contracts";

import type { OperationsDashboardActionFailure } from "./action-result";
import type { OperationsDashboardOverview } from "./operations-dashboard-service";

export type OperationsDashboardRequestStatus =
  | "idle"
  | "loading"
  | "stale"
  | "error";

export type OperationsDashboardViewState = {
  snapshot: OperationsDashboardOverview | null;
  query: OperationsDashboardQueryInput;
  requestStatus: OperationsDashboardRequestStatus;
  failureStatus: OperationsDashboardActionFailure | null;
};

/** 创建单调递增请求门，延迟返回的旧请求不会覆盖新筛选结果。 */
export function createOperationsDashboardRequestGate(): {
  begin: () => number;
  isLatest: (requestId: number) => boolean;
  invalidate: () => void;
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
    invalidate() {
      latestRequestId += 1;
    },
  };
}

/** 开始刷新并保留最近有效快照和已应用查询。 */
export function beginOperationsDashboardRequest(
  state: OperationsDashboardViewState
): OperationsDashboardViewState {
  return {
    ...state,
    requestStatus: "loading",
    failureStatus: null,
  };
}

/** 原子应用一份完整成功快照及对应查询。 */
export function applyOperationsDashboardSnapshot(
  state: OperationsDashboardViewState,
  snapshot: OperationsDashboardOverview,
  query: OperationsDashboardQueryInput
): OperationsDashboardViewState {
  return {
    ...state,
    snapshot,
    query,
    requestStatus: "idle",
    failureStatus: null,
  };
}

/** 记录安全失败；有旧快照时进入 stale，否则进入完整错误状态。 */
export function applyOperationsDashboardFailure(
  state: OperationsDashboardViewState,
  failureStatus: OperationsDashboardActionFailure
): OperationsDashboardViewState {
  return {
    ...state,
    requestStatus: state.snapshot ? "stale" : "error",
    failureStatus,
  };
}
