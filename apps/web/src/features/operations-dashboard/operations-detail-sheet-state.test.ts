/**
 * 运营明细 Sheet 分页状态测试。
 *
 * 使用方：Vitest。锁定打开新明细时替换旧数据、继续加载时追加记录，以及失败保留
 * 已加载页，避免快速切换和 cursor 请求覆盖当前核对结果。
 */
import type { OperationsDashboardQueryInput } from "@repo/shared/operations-dashboard/contracts";
import { describe, expect, it } from "vitest";
import type { OperationsDetailPage } from "./operations-detail-sheet-data";
import {
  applyOperationsDetailFailure,
  applyOperationsDetailPage,
  beginOperationsDetailRequest,
  createOperationsDetailRequestGate,
  createOperationsDetailState,
} from "./operations-detail-sheet-state";

const query: OperationsDashboardQueryInput = {
  granularity: "day",
  range: { kind: "default" },
};
const usersSelection = { module: "growth", detail: "users" } as const;

function createPage(
  userId: string,
  nextCursor: string | null
): OperationsDetailPage {
  return {
    selection: usersSelection,
    range: { timeZone: "Asia/Shanghai" },
    rows: [
      {
        userId,
        name: userId,
        email: `${userId}@example.com`,
        role: "user",
        banned: false,
        businessTime: "2026-08-02T00:00:00.000Z",
        retained: null,
      },
    ],
    nextCursor,
  };
}

describe("operations detail sheet state", () => {
  it("打开 selection 后进入首屏 loading 并清空旧选择", () => {
    const state = beginOperationsDetailRequest(
      createOperationsDetailState(),
      query,
      usersSelection,
      false
    );

    expect(state).toMatchObject({
      query,
      selection: usersSelection,
      rows: [],
      nextCursor: null,
      status: "loading",
      error: null,
    });
  });

  it("继续加载追加记录并保持服务端下一页 cursor", () => {
    const first = applyOperationsDetailPage(
      beginOperationsDetailRequest(
        createOperationsDetailState(),
        query,
        usersSelection,
        false
      ),
      createPage("user-2", "cursor-2"),
      false
    );
    const loadingMore = beginOperationsDetailRequest(
      first,
      query,
      usersSelection,
      true
    );
    const second = applyOperationsDetailPage(
      loadingMore,
      createPage("user-1", null),
      true
    );

    expect(second.rows.map((row) => "userId" in row && row.userId)).toEqual([
      "user-2",
      "user-1",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(second.status).toBe("ready");
  });

  it("继续加载失败保留旧页，首次失败进入 error", () => {
    const ready = applyOperationsDetailPage(
      beginOperationsDetailRequest(
        createOperationsDetailState(),
        query,
        usersSelection,
        false
      ),
      createPage("user-1", "next"),
      false
    );
    expect(
      applyOperationsDetailFailure(
        beginOperationsDetailRequest(ready, query, usersSelection, true),
        "unavailable",
        true
      )
    ).toMatchObject({
      status: "ready",
      error: "unavailable",
      rows: ready.rows,
      nextCursor: "next",
    });

    expect(
      applyOperationsDetailFailure(
        beginOperationsDetailRequest(
          createOperationsDetailState(),
          query,
          usersSelection,
          false
        ),
        "not_ready",
        false
      )
    ).toMatchObject({ status: "error", error: "not_ready", rows: [] });
  });

  it("快速切换请求只允许最新 selection 提交", () => {
    const gate = createOperationsDetailRequestGate();
    const usersRequest = gate.begin();
    const activityRequest = gate.begin();

    expect(gate.isLatest(usersRequest)).toBe(false);
    expect(gate.isLatest(activityRequest)).toBe(true);
  });
});
