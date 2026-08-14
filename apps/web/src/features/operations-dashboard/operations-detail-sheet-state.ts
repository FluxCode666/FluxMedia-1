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

export type OperationsDetailContext = {
  key: string;
  query: OperationsDashboardQueryInput;
  selection: OperationsDetailSelection;
};

export type OperationsDetailSheetState = {
  contextKey: string | null;
  selection: OperationsDetailSelection | null;
  range: OperationsDetailPage["range"] | null;
  rows: OperationsDetailSheetRow[];
  nextCursor: string | null;
  status: "idle" | "loading" | "loading_more" | "ready" | "error";
  error: OperationsDetailFailure | null;
};

/** 创建未选择明细的初始状态。 */
export function createOperationsDetailState(): OperationsDetailSheetState {
  return {
    contextKey: null,
    selection: null,
    range: null,
    rows: [],
    nextCursor: null,
    status: "idle",
    error: null,
  };
}

/**
 * 从封闭查询与 selection 派生值稳定的请求上下文。
 *
 * @param query 当前已应用的运营查询。
 * @param selection 当前明细入口。
 * @returns 包含结构化输入与稳定比较键的上下文。
 */
export function createOperationsDetailContext(
  query: OperationsDashboardQueryInput,
  selection: OperationsDetailSelection
): OperationsDetailContext {
  const rangeParts =
    query.range.kind === "custom"
      ? [query.range.kind, query.range.from, query.range.to]
      : [query.range.kind];
  const selectionParts =
    selection.module === "growth" && selection.detail === "retention_cohorts"
      ? [
          selection.module,
          selection.detail,
          selection.cohortDate,
          selection.retentionDay,
        ]
      : [selection.module, selection.detail];
  return {
    key: JSON.stringify([query.granularity, ...rangeParts, ...selectionParts]),
    query,
    selection,
  };
}

/** 仅允许打开的 Sheet 展示与当前请求上下文完全一致的状态。 */
export function isOperationsDetailStateVisible(
  state: OperationsDetailSheetState,
  open: boolean,
  context: OperationsDetailContext
): boolean {
  return open && state.contextKey === context.key;
}

/** 标记一次首屏或 cursor 请求，继续加载时保留现有页。 */
export function beginOperationsDetailRequest(
  state: OperationsDetailSheetState,
  query: OperationsDashboardQueryInput,
  selection: OperationsDetailSelection,
  append: boolean
): OperationsDetailSheetState {
  const contextKey = createOperationsDetailContext(query, selection).key;
  return append
    ? {
        ...state,
        contextKey,
        selection,
        status: "loading_more",
        error: null,
      }
    : {
        contextKey,
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
  invalidate: () => void;
  isLatest: (requestId: number) => boolean;
} {
  let latestRequestId = 0;
  return {
    begin() {
      latestRequestId += 1;
      return latestRequestId;
    },
    /** 递增请求号，使关闭前所有仍在等待的响应永久失效。 */
    invalidate() {
      latestRequestId += 1;
    },
    isLatest(requestId) {
      return requestId === latestRequestId;
    },
  };
}
