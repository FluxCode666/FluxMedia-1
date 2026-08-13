/**
 * 推广关系 URL 分页测试。
 *
 * 使用方：Vitest；验证 relationship namespace、非法状态恢复、页大小重置和
 * 越界 canonicalization URL 不会破坏同页其他查询参数。
 */
import { parsePaginationConfig } from "@repo/shared/pagination/config";
import { describe, expect, it } from "vitest";

import {
  buildReferralRelationshipPageHref,
  buildReferralRelationshipPageSizeHref,
  parseReferralRelationshipPagination,
} from "./referral-pagination";

const paginationConfig = parsePaginationConfig([10, 20, 50]);

describe("referral relationship pagination URL", () => {
  it("parses only valid namespaced pagination state", () => {
    expect(
      parseReferralRelationshipPagination(
        { relationshipPage: "3", relationshipPageSize: "50" },
        paginationConfig
      )
    ).toEqual({ page: 3, pageSize: 50 });
    expect(
      parseReferralRelationshipPagination(
        {
          relationshipPage: ["3"],
          relationshipPageSize: "999",
        },
        paginationConfig
      )
    ).toEqual({ page: 1, pageSize: 20 });
  });

  it("resets page on page-size changes and preserves unrelated params", () => {
    expect(
      buildReferralRelationshipPageSizeHref(
        {
          relationshipPage: "4",
          relationshipPageSize: "20",
          view: "compact",
        },
        50
      )
    ).toBe("/dashboard/referrals?relationshipPageSize=50&view=compact");
  });

  it("builds the canonical clamped page without changing page size", () => {
    expect(
      buildReferralRelationshipPageHref(
        {
          relationshipPage: "9",
          relationshipPageSize: "50",
          view: "compact",
        },
        2
      )
    ).toBe(
      "/dashboard/referrals?relationshipPage=2&relationshipPageSize=50&view=compact"
    );
  });
});
