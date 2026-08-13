/**
 * 推广关系明细的 URL 分页状态。
 *
 * 使用方：推广页 Server Component、页大小选择器与统一页码控件。参数使用
 * relationship namespace，避免后续同页增加其他列表时互相覆盖。
 */
import type { PaginationConfig } from "@repo/shared/pagination/config";
import { parsePaginationState } from "@repo/shared/pagination/state";
import {
  buildPaginationHref,
  createPaginationUrlParamNames,
} from "@repo/shared/pagination/url-adapter";

export type ReferralSearchParams = Record<
  string,
  string | string[] | undefined
>;

export const REFERRAL_RELATIONSHIP_PAGINATION_NAMES =
  createPaginationUrlParamNames("relationship");

/** 从公开 URL 严格解析推广关系分页状态。 */
export function parseReferralRelationshipPagination(
  searchParams: ReferralSearchParams,
  paginationConfig: PaginationConfig
) {
  return parsePaginationState(
    {
      page: searchParams[REFERRAL_RELATIONSHIP_PAGINATION_NAMES.page],
      pageSize: searchParams[REFERRAL_RELATIONSHIP_PAGINATION_NAMES.pageSize],
    },
    paginationConfig
  );
}

/** 构造保留当前参数且重置到首屏的推广关系页大小 URL。 */
export function buildReferralRelationshipPageSizeHref(
  searchParams: ReferralSearchParams,
  pageSize: number
): string {
  const current = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    if (typeof value === "string") current.set(name, value);
  }
  return buildPaginationHref(
    "/dashboard/referrals",
    current,
    REFERRAL_RELATIONSHIP_PAGINATION_NAMES,
    { pageSize },
    "criteria"
  );
}

/** 构造保留其他参数的指定推广关系页 URL，用于越界 canonicalization。 */
export function buildReferralRelationshipPageHref(
  searchParams: ReferralSearchParams,
  page: number
): string {
  const current = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    if (typeof value === "string") current.set(name, value);
  }
  return buildPaginationHref(
    "/dashboard/referrals",
    current,
    REFERRAL_RELATIONSHIP_PAGINATION_NAMES,
    { page },
    "page"
  );
}
