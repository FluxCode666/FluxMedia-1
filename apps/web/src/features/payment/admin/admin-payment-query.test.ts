/**
 * 管理端支付 URL 状态测试。
 *
 * 覆盖白名单解析、非法值丢弃和筛选 URL 编码，确保客户端不能绕过 UOL 输入边界。
 */
import { describe, expect, it } from "vitest";

import {
  buildAdminPaymentOrdersHref,
  buildAdminPaymentOverviewHref,
  buildCalendarMonthRange,
  buildCalendarPresetRange,
  buildRecentCalendarDaysRange,
  parseAdminPaymentDateRange,
  parseAdminPaymentOrderQuery,
} from "./admin-payment-query";

describe("admin payment query", () => {
  it("parses valid order filters and rejects arrays or unknown status", () => {
    expect(
      parseAdminPaymentOrderQuery(
        {
          cursor: "signed-cursor",
          endDate: "2026-07-28",
          orderId: "AT123",
          startDate: "2026-07-22",
          status: "fulfilled",
          userEmail: "buyer@example.com",
        },
        "2026-07-28"
      )
    ).toEqual({
      cursor: "signed-cursor",
      endDate: "2026-07-28",
      orderId: "AT123",
      page: 1,
      pageSize: 20,
      startDate: "2026-07-22",
      status: "fulfilled",
      userEmail: "buyer@example.com",
    });
    expect(
      parseAdminPaymentOrderQuery(
        {
          orderId: ["AT123"],
          status: "expired",
          userEmail: "not-an-email",
        },
        "2026-07-28"
      )
    ).toEqual({
      cursor: null,
      endDate: "2026-07-28",
      orderId: null,
      page: 1,
      pageSize: 20,
      startDate: "2026-07-22",
      status: null,
      userEmail: null,
    });
  });

  it("encodes filters and cursor without a locale prefix", () => {
    expect(
      buildAdminPaymentOrdersHref({
        cursor: "a.b",
        endDate: "2026-07-28",
        orderId: "CP 123",
        page: 1,
        pageSize: 20,
        startDate: "2026-07-22",
        status: "pending",
        userEmail: "buyer+one@example.com",
      })
    ).toBe(
      "/dashboard/admin/payments/orders?startDate=2026-07-22&endDate=2026-07-28&userEmail=buyer%2Bone%40example.com&orderId=CP+123&status=pending&cursor=a.b"
    );
  });

  it("accepts only configured page sizes and preserves non-default size", () => {
    const paginationConfig = {
      defaultPageSize: 20 as const,
      pageSizeOptions: [10, 20, 40],
    };
    const state = parseAdminPaymentOrderQuery(
      { pageSize: "40" },
      "2026-07-28",
      paginationConfig
    );
    expect(state.pageSize).toBe(40);
    expect(buildAdminPaymentOrdersHref(state)).toContain("pageSize=40");
    expect(
      parseAdminPaymentOrderQuery(
        { pageSize: "50" },
        "2026-07-28",
        paginationConfig
      ).pageSize
    ).toBe(20);
  });

  it("falls back to the latest seven days for incomplete or future order ranges", () => {
    const expected = {
      cursor: null,
      endDate: "2026-07-28",
      orderId: null,
      page: 1,
      pageSize: 20,
      startDate: "2026-07-22",
      status: null,
      userEmail: null,
    };

    expect(
      parseAdminPaymentOrderQuery({ startDate: "2026-07-01" }, "2026-07-28")
    ).toEqual(expected);
    expect(
      parseAdminPaymentOrderQuery(
        {
          startDate: "2026-07-28",
          endDate: "2026-07-29",
        },
        "2026-07-28"
      )
    ).toEqual(expected);
  });

  it("accepts only complete bounded calendar date ranges", () => {
    expect(
      parseAdminPaymentDateRange({
        startDate: "2026-06-20",
        endDate: "2026-07-20",
      })
    ).toEqual({ startDate: "2026-06-20", endDate: "2026-07-20" });
    expect(
      parseAdminPaymentDateRange({
        startDate: "2026-07-20",
        endDate: "2026-07-01",
      })
    ).toBeNull();
    expect(parseAdminPaymentDateRange({ startDate: "2026-07-01" })).toBeNull();
    expect(
      parseAdminPaymentDateRange({
        startDate: ["2026-07-01"],
        endDate: ["2026-07-31"],
      })
    ).toBeNull();
    expect(
      parseAdminPaymentDateRange({
        startDate: "2026-02-30",
        endDate: "2026-03-01",
      })
    ).toBeNull();
    expect(
      parseAdminPaymentDateRange({
        startDate: "2025-01-01",
        endDate: "2026-01-02",
      })
    ).toBeNull();
    expect(parseAdminPaymentDateRange({ month: "2026-07" })).toBeNull();
  });

  it("builds overview range URLs and full calendar month defaults", () => {
    const range = buildCalendarMonthRange("2028-02-15");
    expect(range).toEqual({
      startDate: "2028-02-01",
      endDate: "2028-02-29",
    });
    expect(buildAdminPaymentOverviewHref(range)).toBe(
      "/dashboard/admin/payments?startDate=2028-02-01&endDate=2028-02-29"
    );
  });

  it("builds an inclusive recent seven-day range across month boundaries", () => {
    expect(buildRecentCalendarDaysRange("2026-07-03")).toEqual({
      startDate: "2026-06-27",
      endDate: "2026-07-03",
    });
  });

  it.each([
    ["month", "2028-02-15", { startDate: "2028-02-01", endDate: "2028-02-29" }],
    [
      "quarter",
      "2026-07-28",
      { startDate: "2026-07-01", endDate: "2026-09-30" },
    ],
    [
      "quarter",
      "2028-02-15",
      { startDate: "2028-01-01", endDate: "2028-03-31" },
    ],
    ["year", "2028-02-15", { startDate: "2028-01-01", endDate: "2028-12-31" }],
  ] as const)("builds the %s natural range containing %s", (preset, calendarDate, expectedRange) => {
    expect(buildCalendarPresetRange(calendarDate, preset)).toEqual(
      expectedRange
    );
  });
});
