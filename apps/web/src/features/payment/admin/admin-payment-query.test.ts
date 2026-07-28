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
  parseAdminPaymentDateRange,
  parseAdminPaymentOrderQuery,
} from "./admin-payment-query";

describe("admin payment query", () => {
  it("parses valid order filters and rejects arrays or unknown status", () => {
    expect(
      parseAdminPaymentOrderQuery({
        cursor: "signed-cursor",
        orderId: "AT123",
        status: "fulfilled",
        userEmail: "buyer@example.com",
      })
    ).toEqual({
      cursor: "signed-cursor",
      orderId: "AT123",
      status: "fulfilled",
      userEmail: "buyer@example.com",
    });
    expect(
      parseAdminPaymentOrderQuery({
        orderId: ["AT123"],
        status: "expired",
        userEmail: "not-an-email",
      })
    ).toEqual({
      cursor: null,
      orderId: null,
      status: null,
      userEmail: null,
    });
  });

  it("encodes filters and cursor without a locale prefix", () => {
    expect(
      buildAdminPaymentOrdersHref({
        cursor: "a.b",
        orderId: "CP 123",
        status: "pending",
        userEmail: "buyer+one@example.com",
      })
    ).toBe(
      "/dashboard/admin/payments/orders?userEmail=buyer%2Bone%40example.com&orderId=CP+123&status=pending&cursor=a.b"
    );
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
