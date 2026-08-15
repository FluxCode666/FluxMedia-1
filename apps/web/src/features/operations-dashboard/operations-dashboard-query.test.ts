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
      detailSelection: null,
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
      detailSelection: null,
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
      detailSelection: null,
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

  it("往返解析可分享的趋势桶与 Cohort 明细", () => {
    const input = {
      granularity: "week" as const,
      range: {
        kind: "custom" as const,
        from: "2026-08-01",
        to: "2026-08-14",
      },
    };
    const activitySelection = {
      module: "growth" as const,
      detail: "activity_bucket" as const,
      activityKind: "creation" as const,
      bucket: { from: "2026-08-04", to: "2026-08-10" },
    };
    const activityHref = buildOperationsDashboardHref(input, activitySelection);

    expect(activityHref).toBe(
      "/dashboard/admin/operations?range=custom&from=2026-08-01&to=2026-08-14&granularity=week&detail=activity_bucket&activityKind=creation&bucket=2026-08-04_2026-08-10"
    );
    expect(
      parseOperationsDashboardSearchParams(
        Object.fromEntries(
          new URL(activityHref, "https://example.com").searchParams
        )
      )
    ).toEqual({
      input,
      detailSelection: activitySelection,
      invalidDeepLink: false,
      canonicalHref: activityHref,
    });

    const cohortSelection = {
      module: "growth" as const,
      detail: "retention_cohorts" as const,
      cohortDate: "2026-08-01",
      retentionDay: 7 as const,
    };
    const cohortHref = buildOperationsDashboardHref(input, cohortSelection);
    expect(cohortHref).toContain(
      "detail=retention_cohorts&cohortDate=2026-08-01&retentionDay=7"
    );
    expect(
      parseOperationsDashboardSearchParams(
        Object.fromEntries(
          new URL(cohortHref, "https://example.com").searchParams
        )
      ).detailSelection
    ).toEqual(cohortSelection);
  });

  it("往返解析商业化、内容与累计用户明细参数", () => {
    const input = {
      granularity: "day" as const,
      range: { kind: "this_month" as const },
    };
    const selections = [
      {
        module: "growth" as const,
        detail: "cumulative_users" as const,
        cutoffDate: "2026-08-14",
      },
      {
        module: "commercialization" as const,
        detail: "payment_stage" as const,
        stage: "fulfilled_orders" as const,
        currency: "CNY",
      },
      {
        module: "content" as const,
        detail: "content_bucket" as const,
        contentKind: "credits" as const,
        bucket: { from: "2026-08-01", to: "2026-08-07" },
      },
    ];

    for (const selection of selections) {
      const href = buildOperationsDashboardHref(input, selection);
      expect(
        parseOperationsDashboardSearchParams(
          Object.fromEntries(new URL(href, "https://example.com").searchParams)
        )
      ).toMatchObject({ input, detailSelection: selection });
    }
  });

  it.each([
    { detail: "activity_bucket", activityKind: "login" },
    {
      detail: "activity_bucket",
      activityKind: "login",
      bucket: "2026-08-02_2026-08-01",
    },
    { detail: "retention_cohorts", cohortDate: "2026-08-01" },
    { detail: "payment_stage", stage: "unknown" },
    { detail: "users", currency: "CNY" },
    { bucket: "2026-08-01_2026-08-01" },
  ])("非法明细深链 %o 回退默认 canonical", (params) => {
    expect(parseOperationsDashboardSearchParams(params)).toEqual({
      input: { granularity: "day", range: { kind: "default" } },
      detailSelection: null,
      invalidDeepLink: true,
      canonicalHref: "/dashboard/admin/operations",
    });
  });
});
