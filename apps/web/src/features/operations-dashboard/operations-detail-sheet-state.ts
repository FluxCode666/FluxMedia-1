/**
 * 运营明细 Sheet 的纯分页状态机。
 *
 * 使用方：客户端 Sheet 与 DB-free 测试。状态机把初始加载、继续加载和失败保留规则
 * 与 React 分离，确保 cursor 失败不会清空已加载的核对记录。
 */
import type { OperationsDashboardQueryInput } from "@repo/shared/operations-dashboard/contracts";

import type {
  OperationsDetailPage,
  OperationsDetailSelection,
  OperationsDetailSheetRow,
} from "./operations-detail-sheet-data";

export type OperationsDetailFailure =
  | "validation_error"
  | "not_ready"
  | "rate_limited"
  | "timeout"
  | "unavailable";

export type OperationsDetailSheetState = {
  query: OperationsDashboardQueryInput | null;
  selection: OperationsDetailSelection | null;
  range: Record<string, unknown> | null;
  rows: OperationsDetailSheetRow[];
  nextCursor: string | null;
  status: "idle" | "loading" | "loading_more" | "ready" | "error";
  error: OperationsDetailFailure | null;
};

/** 创建未选择明细的初始状态。 */
export function createOperationsDetailState(): OperationsDetailSheetState {
  return {
    query: null,
    selection: null,
    range: null,
    rows: [],
    nextCursor: null,
    status: "idle",
    error: null,
  };
}

/** 标记一次首屏或 cursor 请求，继续加载时保留现有页。 */
export function beginOperationsDetailRequest(
  state: OperationsDetailSheetState,
  query: OperationsDashboardQueryInput,
  selection: OperationsDetailSelection,
  append: boolean
): OperationsDetailSheetState {
  return append
    ? {
        ...state,
        query,
        selection,
        status: "loading_more",
        error: null,
      }
    : {
        query,
        selection,
        range: null,
        rows: [],
        nextCursor: null,
        status: "loading",
        error: null,
      };
}

/** 提交通过 selection 校验的明细页；cursor 页只追加记录。 */
export function applyOperationsDetailPage(
  state: OperationsDetailSheetState,
  page: OperationsDetailPage,
  append: boolean
): OperationsDetailSheetState {
  return {
    ...state,
    range: page.range,
    rows: append ? [...state.rows, ...page.rows] : page.rows,
    nextCursor: page.nextCursor,
    status: "ready",
    error: null,
  };
}

/** 失败时首屏显示错误，cursor 失败则保留已加载页并允许重试。 */
export function applyOperationsDetailFailure(
  state: OperationsDetailSheetState,
  error: OperationsDetailFailure,
  append: boolean
): OperationsDetailSheetState {
  return {
    ...state,
    status: append && state.rows.length > 0 ? "ready" : "error",
    error,
  };
}

/** 生成单调请求号，使快速切换 selection 时只有最新响应可以提交。 */
export function createOperationsDetailRequestGate(): {
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
