/**
 * Web 分页 URL adapter 的兼容导出。
 *
 * 使用方：apps/web 既有分页组件；纯实现位于 @repo/shared，确保共享包中的
 * 客户端管理列表可以使用相同的 namespace 和 canonicalization 规则。
 */
export {
  buildPaginationHref,
  createPaginationUrlParamNames,
  type PaginationUrlParamNames,
  type PaginationUrlState,
  type PaginationUrlUpdate,
  type PaginationUrlUpdateMode,
  parsePaginationUrlState,
} from "@repo/shared/pagination/url-adapter";
