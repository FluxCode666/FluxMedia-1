/**
 * 运营总览 URL 白名单与 canonical 测试。
 *
 * 使用方：Vitest；锁定默认、三个快捷范围、自定义范围、粒度和非法深链回退。
 */
import { describe, expect, it } from "vitest";

import {
  buildOperationsDashboardHref,
  parseOperationsDashboardSearchParams,
} from "./operations-dashboard-query";

describe("operations dashboard query", () => {
  it.each([
    [{}, { granularity: "day", range: { kind: "default" } }],
    [
      { range: "this_week", granularity: "week" },
      { granularity: "week", range: { kind: "this_week" } },
    ],
    [
      { range: "this_month", granularity: "month" },
      { granularity: "month", range: { kind: "this_month" } },
    ],
    [
      { range: "this_year", granularity: "day" },
      { granularity: "day", range: { kind: "this_year" } },
    ],
  ] as const)("把白名单查询 %o 映射为 strict 输入", (params, input) => {
    expect(parseOperationsDashboardSearchParams(params)).toEqual({
      input: { ...input },
      invalidDeepLink: false,
      canonicalHref: buildOperationsDashboardHref(input),
    });
  });

  it("保留自定义跨多年范围和月粒度", () => {
    const result = parseOperationsDashboardSearchParams({
      range: "custom",
      from: "2023-01-01",
      to: "2026-08-14",
      granularity: "month",
    });

    expect(result).toEqual({
      input: {
        granularity: "month",
        range: {
          kind: "custom",
          from: "2023-01-01",
          to: "2026-08-14",
        },
      },
      invalidDeepLink: false,
      canonicalHref:
        "/dashboard/admin/operations?range=custom&from=2023-01-01&to=2026-08-14&granularity=month",
    });
  });

  it.each([
    { range: "custom", from: "2026-08-01" },
    { range: "custom", from: "2026-08-14", to: "2026-08-01" },
    { range: "last_30_days", granularity: "day" },
    { granularity: "hour" },
    { range: ["this_week"] },
    { range: "this_week", userId: "user-1" },
  ])("非法深链 %o 回退 canonical 默认并保留标记", (params) => {
    expect(parseOperationsDashboardSearchParams(params)).toEqual({
      input: { granularity: "day", range: { kind: "default" } },
      invalidDeepLink: true,
      canonicalHref: "/dashboard/admin/operations",
    });
  });

  it("只在非默认条件输出稳定参数顺序", () => {
    expect(
      buildOperationsDashboardHref({
        granularity: "week",
        range: { kind: "this_month" },
      })
    ).toBe("/dashboard/admin/operations?range=this_month&granularity=week");
    expect(
      buildOperationsDashboardHref({
        granularity: "day",
        range: { kind: "default" },
      })
    ).toBe("/dashboard/admin/operations");
  });
});
