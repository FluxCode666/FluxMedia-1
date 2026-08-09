/**
 * 数据看板 URL 与快捷范围纯函数测试。
 *
 * 使用方：Vitest；固定成对日期深链、非法参数回退、canonical URL 和账号时区 today
 * 下的近 7/30 个自然日，避免组件与 RSC 各自解释 query。
 */
import { describe, expect, it } from "vitest";

import {
  buildDataDashboardHref,
  buildDataDashboardPresetRange,
  isDefaultDataDashboardRange,
  parseDataDashboardSearchParams,
} from "./data-dashboard-query";

describe("parseDataDashboardSearchParams", () => {
  it("无参数使用动态默认范围", () => {
    expect(parseDataDashboardSearchParams({})).toEqual({
      input: {},
      invalidDeepLink: false,
    });
  });

  it("只接受成对 Gregorian 日期", () => {
    expect(
      parseDataDashboardSearchParams({
        startDate: "2026-08-01",
        endDate: "2026-08-09",
      })
    ).toEqual({
      input: { startDate: "2026-08-01", endDate: "2026-08-09" },
      invalidDeepLink: false,
    });

    for (const params of [
      { startDate: "2026-08-01" },
      { endDate: "2026-08-09" },
      { startDate: ["2026-08-01"], endDate: "2026-08-09" },
      { startDate: "2026-02-29", endDate: "2026-03-01" },
      {
        startDate: "2026-08-01",
        endDate: "2026-08-09",
        userId: "another-user",
      },
    ]) {
      expect(parseDataDashboardSearchParams(params)).toEqual({
        input: {},
        invalidDeepLink: true,
      });
    }
  });
});

describe("data dashboard URL and presets", () => {
  it("默认范围使用 canonical 无参数 URL，自定义范围保留成对日期", () => {
    expect(buildDataDashboardHref({})).toBe("/dashboard/analytics");
    expect(
      buildDataDashboardHref({
        startDate: "2026-08-01",
        endDate: "2026-08-09",
      })
    ).toBe(
      "/dashboard/analytics?startDate=2026-08-01&endDate=2026-08-09"
    );
  });

  it("按账号时区 today 构造近七天和近三十天", () => {
    expect(buildDataDashboardPresetRange("2026-08-09", 7)).toEqual({
      startDate: "2026-08-03",
      endDate: "2026-08-09",
    });
    expect(buildDataDashboardPresetRange("2026-08-09", 30)).toEqual({
      startDate: "2026-07-11",
      endDate: "2026-08-09",
    });
  });

  it("只有动态近七天被识别为 canonical 默认范围", () => {
    expect(
      isDefaultDataDashboardRange(
        { startDate: "2026-08-03", endDate: "2026-08-09" },
        "2026-08-09"
      )
    ).toBe(true);
    expect(
      isDefaultDataDashboardRange(
        { startDate: "2026-08-02", endDate: "2026-08-09" },
        "2026-08-09"
      )
    ).toBe(false);
  });
});
