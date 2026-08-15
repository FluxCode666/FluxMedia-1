/**
 * 运营总览客户端状态机测试。
 *
 * 使用方：Vitest；锁定最新请求胜出、失败保留旧快照和首次失败状态。
 */
import type { OperationsDashboardQueryInput } from "@repo/shared/operations-dashboard/contracts";
import { describe, expect, it } from "vitest";
import { createLatestRequestGate } from "./latest-request-gate";
import type { OperationsDashboardOverview } from "./operations-dashboard-service";
import {
  applyOperationsDashboardFailure,
  applyOperationsDashboardSnapshot,
  beginOperationsDashboardRequest,
  type OperationsDashboardViewState,
} from "./operations-dashboard-state";

const defaultQuery: OperationsDashboardQueryInput = {
  granularity: "day",
  range: { kind: "default" },
};
const customQuery: OperationsDashboardQueryInput = {
  granularity: "week",
  range: { kind: "custom", from: "2026-01-01", to: "2026-08-14" },
};
const snapshot = {
  generatedAt: "2026-08-14T00:00:00.000Z",
} as unknown as OperationsDashboardOverview;

/** 创建测试所需的最小初始状态。 */
function createState(
  initialSnapshot: OperationsDashboardOverview | null
): OperationsDashboardViewState {
  return {
    snapshot: initialSnapshot,
    query: defaultQuery,
    requestStatus: initialSnapshot ? "idle" : "error",
    failureStatus: initialSnapshot ? null : "unavailable",
  };
}

describe("operations dashboard state", () => {
  it("只承认最后开始的请求", () => {
    const gate = createLatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);

    gate.invalidate();
    expect(gate.isLatest(second)).toBe(false);
  });

  it("刷新失败时保留旧快照和查询", () => {
    const loading = beginOperationsDashboardRequest(createState(snapshot));
    const failed = applyOperationsDashboardFailure(loading, "timeout");

    expect(failed).toMatchObject({
      snapshot,
      query: defaultQuery,
      requestStatus: "stale",
      failureStatus: "timeout",
    });
  });

  it("成功时原子替换快照和已应用查询", () => {
    const nextSnapshot = {
      generatedAt: "2026-08-14T01:00:00.000Z",
    } as unknown as OperationsDashboardOverview;
    const next = applyOperationsDashboardSnapshot(
      createState(snapshot),
      nextSnapshot,
      customQuery
    );

    expect(next).toMatchObject({
      snapshot: nextSnapshot,
      query: customQuery,
      requestStatus: "idle",
      failureStatus: null,
    });
  });

  it("首次读取失败时进入完整错误状态", () => {
    const failed = applyOperationsDashboardFailure(
      createState(null),
      "not_ready"
    );

    expect(failed.requestStatus).toBe("error");
    expect(failed.snapshot).toBeNull();
  });
});
