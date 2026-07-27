/**
 * 管理端支付 URL 状态测试。
 *
 * 覆盖白名单解析、非法值丢弃和筛选 URL 编码，确保客户端不能绕过 UOL 输入边界。
 */
import { describe, expect, it } from "vitest";

import {
  buildAdminPaymentOrdersHref,
  parseAdminPaymentMonth,
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

  it("accepts only bounded calendar months", () => {
    expect(parseAdminPaymentMonth({ month: "2026-07" })).toBe("2026-07");
    expect(parseAdminPaymentMonth({ month: "2026-13" })).toBeNull();
    expect(parseAdminPaymentMonth({ month: ["2026-07"] })).toBeNull();
  });
});
