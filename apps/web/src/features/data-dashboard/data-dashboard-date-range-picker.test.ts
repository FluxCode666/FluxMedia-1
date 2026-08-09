/**
 * 数据看板日期选择器纯校验测试。
 *
 * 使用方：Vitest；固定未完成、反向、未来和 31 天草稿不能应用，30 天可以应用，
 * 选择草稿本身不会触发查询。
 */
import { describe, expect, it } from "vitest";

import { validateDataDashboardDraftRange } from "./data-dashboard-date-range-picker";

describe("validateDataDashboardDraftRange", () => {
  it.each([
    [{ startDate: "", endDate: "" }, "incomplete"],
    [{ startDate: "2026-08-01", endDate: "" }, "incomplete"],
    [
      { startDate: "2026-08-09", endDate: "2026-08-08" },
      "reversed",
    ],
    [
      { startDate: "2026-08-01", endDate: "2026-08-10" },
      "future",
    ],
    [
      { startDate: "2026-07-10", endDate: "2026-08-09" },
      "too_long",
    ],
  ] as const)("拒绝 %j 为 %s", (range, reason) => {
    expect(validateDataDashboardDraftRange(range, "2026-08-09")).toEqual({
      valid: false,
      reason,
    });
  });

  it("接受首尾包含三十天的完整范围", () => {
    expect(
      validateDataDashboardDraftRange(
        { startDate: "2026-07-11", endDate: "2026-08-09" },
        "2026-08-09"
      )
    ).toEqual({ valid: true, dayCount: 30 });
  });
});
