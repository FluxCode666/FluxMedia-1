/**
 * 数据列表的通用分页状态与页码窗口算法。
 *
 * 使用方：UOL 列表 operation、Server Component URL 解析和共享分页控件。
 * 本文件保持 DB-free，不读取路由、数据库或运行时配置。
 */
import type { PaginationConfig } from "./config";

export type PaginationSearchParam = string | string[] | undefined;

export type PaginationState = {
  page: number;
  pageSize: number;
};

export type ResolvedPaginationState = PaginationState & {
  totalCount: number;
  totalPages: number;
  hasNavigation: boolean;
};

export type PaginationWindowItem = number | "start-ellipsis" | "end-ellipsis";

const PAGINATION_WINDOW_SIZE = 7;

/**
 * 严格解析正整数 URL 参数。
 *
 * @param value - 未信任的单值或数组查询参数。
 * @param fallback - 非法值的安全回退值。
 * @returns 不超过 Number.MAX_SAFE_INTEGER 的十进制正整数。
 */
export function parsePositivePageInteger(
  value: PaginationSearchParam,
  fallback = 1
): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 解析一组 page/pageSize 查询参数。
 *
 * @param input - 未信任的分页查询参数。
 * @param config - 当前允许的页大小配置。
 * @returns 可安全交给列表 operation 的初始分页状态。
 */
export function parsePaginationState(
  input: {
    page?: PaginationSearchParam;
    pageSize?: PaginationSearchParam;
  },
  config: PaginationConfig
): PaginationState {
  const requestedPageSize = parsePositivePageInteger(input.pageSize, 0);
  return {
    page: parsePositivePageInteger(input.page),
    pageSize: config.pageSizeOptions.includes(requestedPageSize)
      ? requestedPageSize
      : config.defaultPageSize,
  };
}

/**
 * 根据精确总数计算总页数。
 *
 * @param totalCount - 当前权限和筛选口径下的精确总条数。
 * @param pageSize - 已通过白名单校验的正整数页大小。
 * @returns 至少为 1 的总页数；零结果仍规范化为第一页。
 * @throws 输入不是安全的非负整数或正整数时抛出 RangeError。
 */
export function calculateTotalPages(
  totalCount: number,
  pageSize: number
): number {
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new RangeError("totalCount 必须是安全的非负整数");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize 必须是安全的正整数");
  }
  return Math.max(1, Math.ceil(totalCount / pageSize));
}

/**
 * 把页码收敛到当前总页数内。
 *
 * @param page - 请求页码。
 * @param totalPages - 已计算的总页数。
 * @returns 1 到 totalPages 之间的页码。
 */
export function clampPaginationPage(page: number, totalPages: number): number {
  const safeTotalPages = Number.isSafeInteger(totalPages)
    ? Math.max(1, totalPages)
    : 1;
  const safePage = Number.isSafeInteger(page) ? Math.max(1, page) : 1;
  return Math.min(safePage, safeTotalPages);
}

/**
 * 使用精确总数解析最终分页状态。
 *
 * @param state - 已完成 URL 白名单解析的分页状态。
 * @param totalCount - 当前列表的精确总条数。
 * @returns 已完成越界收敛且可直接输出的分页元数据。
 */
export function resolvePaginationState(
  state: PaginationState,
  totalCount: number
): ResolvedPaginationState {
  const totalPages = calculateTotalPages(totalCount, state.pageSize);
  return {
    page: clampPaginationPage(state.page, totalPages),
    pageSize: state.pageSize,
    totalCount,
    totalPages,
    hasNavigation: totalPages > 1,
  };
}

/**
 * 生成固定七槽位的桌面数字页码窗口。
 *
 * @param page - 当前页；越界值会先收敛。
 * @param totalPages - 总页数；零或非法值按一页处理。
 * @returns 首尾可达、无重复页码的数字与省略标记。
 */
export function getPaginationWindow(
  page: number,
  totalPages: number
): PaginationWindowItem[] {
  const safeTotalPages = Number.isSafeInteger(totalPages)
    ? Math.max(1, totalPages)
    : 1;
  const currentPage = clampPaginationPage(page, safeTotalPages);

  if (safeTotalPages <= PAGINATION_WINDOW_SIZE) {
    return Array.from({ length: safeTotalPages }, (_, index) => index + 1);
  }
  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, "end-ellipsis", safeTotalPages];
  }
  if (currentPage >= safeTotalPages - 3) {
    return [
      1,
      "start-ellipsis",
      safeTotalPages - 4,
      safeTotalPages - 3,
      safeTotalPages - 2,
      safeTotalPages - 1,
      safeTotalPages,
    ];
  }
  return [
    1,
    "start-ellipsis",
    currentPage - 1,
    currentPage,
    currentPage + 1,
    "end-ellipsis",
    safeTotalPages,
  ];
}
