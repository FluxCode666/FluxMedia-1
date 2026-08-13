/**
 * 博客与 PSEO 索引的 URL 分页适配器。
 *
 * 使用方：两个公开索引 Server Component。统一解析白名单 page/pageSize，并构造
 * 翻页与页大小 URL；详情页、相关推荐和筛选候选不消费本模块。
 */

import type { PaginationConfig } from "@repo/shared/pagination/config";
import { parsePaginationState } from "@repo/shared/pagination/state";
import {
  buildPaginationHref,
  createPaginationUrlParamNames,
} from "@/features/pagination/url-adapter";

export type ContentIndexSearchParams = {
  page?: string | string[];
  pageSize?: string | string[];
};

export const contentPaginationNames = createPaginationUrlParamNames();

/** 将公开 URL 参数严格解析为系统允许的分页状态。 */
export function parseContentIndexPagination(
  searchParams: ContentIndexSearchParams,
  config: PaginationConfig
) {
  return parsePaginationState(searchParams, config);
}

/** 构造指定页 URL，保留同页其他安全参数。 */
export function buildContentIndexPageHref(
  pathname: string,
  searchParams: ContentIndexSearchParams,
  page: number
): string {
  const current = new URLSearchParams();
  if (typeof searchParams.page === "string") {
    current.set("page", searchParams.page);
  }
  if (typeof searchParams.pageSize === "string") {
    current.set("pageSize", searchParams.pageSize);
  }
  return buildPaginationHref(
    pathname,
    current,
    contentPaginationNames,
    { page },
    "page"
  );
}

/** 构造页大小 URL；共享 adapter 会清页码并回到第一页。 */
export function buildContentIndexPageSizeHref(
  pathname: string,
  searchParams: ContentIndexSearchParams,
  pageSize: number
): string {
  const current = new URLSearchParams();
  if (typeof searchParams.page === "string") {
    current.set("page", searchParams.page);
  }
  if (typeof searchParams.pageSize === "string") {
    current.set("pageSize", searchParams.pageSize);
  }
  return buildPaginationHref(
    pathname,
    current,
    contentPaginationNames,
    { pageSize },
    "criteria"
  );
}
