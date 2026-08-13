/**
 * 管理端数据看板 URL 筛选测试。
 *
 * 使用方：Vitest；验证日期与用户 ID 必须严格成对/收窄，且用户筛选可稳定深链恢复。
 */
import { describe, expect, it } from "vitest";

import {
  buildAdminDataDashboardHref,
  parseAdminDataDashboardSearchParams,
  selectAdminDataDashboardRangeInput,
} from "./admin-data-dashboard-query";

describe("admin data dashboard query", () => {
  it("保留用户 ID 与自定义日期范围", () => {
    expect(parseAdminDataDashboardSearchParams({ userId: "user-1" })).toEqual({
      input: { userId: "user-1" },
      invalidDeepLink: false,
    });
    expect(
      buildAdminDataDashboardHref({
        startDate: "2026-08-03",
        endDate: "2026-08-09",
        userId: "user-1",
      })
    ).toBe(
      "/dashboard/admin/analytics?startDate=2026-08-03&endDate=2026-08-09&userId=user-1"
    );
  });

  it("拒绝数组、单边日期、空用户 ID 和未知筛选字段", () => {
    for (const params of [
      { userId: "" },
      { startDate: "2026-08-03", userId: "user-1" },
      { startDate: ["2026-08-03"], endDate: "2026-08-09" },
      { userId: "user-1", role: "admin" },
    ]) {
      expect(parseAdminDataDashboardSearchParams(params)).toEqual({
        input: {},
        invalidDeepLink: true,
      });
    }
  });

  it("重试输入只提取日期范围并保留默认范围语义", () => {
    expect(
      selectAdminDataDashboardRangeInput({
        startDate: "2026-08-03",
        endDate: "2026-08-09",
        userId: "user-1",
      })
    ).toEqual({ startDate: "2026-08-03", endDate: "2026-08-09" });
    expect(selectAdminDataDashboardRangeInput({ userId: "user-1" })).toEqual(
      {}
    );
  });
});
