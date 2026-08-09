/**
 * 数据看板客户端快照状态协议测试。
 *
 * 使用方：Vitest；验证最新请求胜出，以及失败只改变状态、不替换已应用范围、快照和
 * asOf。组件本身复用这些纯函数，避免通过计时测试掩盖竞态。
 */
import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { describe, expect, it } from "vitest";

import {
  applyDataDashboardActionResult,
  createDataDashboardRequestGate,
  type DataDashboardViewState,
} from "./data-dashboard-state";

const oldSnapshot = {
  asOf: "2026-08-09T10:00:00.000Z",
} as unknown as DataDashboardOutput;
const newSnapshot = {
  asOf: "2026-08-09T11:00:00.000Z",
  range: { startDate: "2026-08-01", endDate: "2026-08-09" },
} as unknown as DataDashboardOutput;

const oldState: DataDashboardViewState = {
  snapshot: oldSnapshot,
  appliedRange: { startDate: "2026-08-03", endDate: "2026-08-09" },
  requestStatus: "idle",
  failureStatus: null,
};

describe("data dashboard request state", () => {
  it("快速发起 A、B 后只允许 B 提交", () => {
    const gate = createDataDashboardRequestGate();
    const requestA = gate.begin();
    const requestB = gate.begin();

    expect(gate.isLatest(requestA)).toBe(false);
    expect(gate.isLatest(requestB)).toBe(true);
  });

  it("成功时原子替换快照与已应用范围", () => {
    expect(
      applyDataDashboardActionResult(oldState, {
        status: "ready",
        snapshot: newSnapshot,
      })
    ).toEqual({
      snapshot: newSnapshot,
      appliedRange: { startDate: "2026-08-01", endDate: "2026-08-09" },
      requestStatus: "idle",
      failureStatus: null,
    });
  });

  it.each(["validation_error", "rate_limited", "unavailable"] as const)(
    "%s 失败保留旧快照、范围与 asOf",
    (status) => {
      expect(applyDataDashboardActionResult(oldState, { status })).toEqual({
        ...oldState,
        requestStatus: "stale",
        failureStatus: status,
      });
    }
  );

  it("首次失败进入 error 而不是构造零快照", () => {
    expect(
      applyDataDashboardActionResult(
        {
          snapshot: null,
          appliedRange: null,
          requestStatus: "loading",
          failureStatus: null,
        },
        { status: "not_ready" }
      )
    ).toEqual({
      snapshot: null,
      appliedRange: null,
      requestStatus: "error",
      failureStatus: "not_ready",
    });
  });
});
