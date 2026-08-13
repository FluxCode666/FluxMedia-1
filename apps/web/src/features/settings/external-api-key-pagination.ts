/**
 * API Key 管理页的 URL 分页状态。
 *
 * 使用方：独立 API Key 页面和客户端管理列表。所有分页参数使用 key namespace，
 * 页面大小变化回到第一页，翻页保留同页其他参数。
 */
import type { PaginationConfig } from "@repo/shared/pagination/config";
import { parsePaginationState } from "@repo/shared/pagination/state";
import { createPaginationUrlParamNames } from "@repo/shared/pagination/url-adapter";

export type ExternalApiKeySearchParams = Record<
  string,
  string | string[] | undefined
>;

export const EXTERNAL_API_KEY_PAGINATION_NAMES =
  createPaginationUrlParamNames("key");

export type ExternalApiKeyPaginationState = {
  page: number;
  pageSize: 10 | 20 | 50;
};

/** 从不可信 URL 查询参数中读取本人 API Key 分页状态。 */
export function parseExternalApiKeyPagination(
  searchParams: ExternalApiKeySearchParams,
  paginationConfig: PaginationConfig
): ExternalApiKeyPaginationState {
  const state = parsePaginationState(
    {
      page: searchParams[EXTERNAL_API_KEY_PAGINATION_NAMES.page],
      pageSize: searchParams[EXTERNAL_API_KEY_PAGINATION_NAMES.pageSize],
    },
    paginationConfig
  );
  return {
    page: state.page,
    pageSize:
      state.pageSize === 10 || state.pageSize === 50 ? state.pageSize : 20,
  };
}
