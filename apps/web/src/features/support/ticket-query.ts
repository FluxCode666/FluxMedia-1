/**
 * 客服工单列表与消息历史的 URL 状态适配器。
 *
 * 使用方：工单 Server Components。严格解析 page/pageSize/status/search，构造
 * 筛选和页大小 href 时回第一页，并保留同页不属于当前列表的参数。
 */
import type { PaginationConfig } from "@repo/shared/pagination/config";
import {
  buildPaginationHref,
  createPaginationUrlParamNames,
  parsePaginationUrlState,
} from "@repo/shared/pagination/url-adapter";
import {
  type TicketListInput,
  ticketStatusFilterSchema,
} from "@repo/shared/support/ticket-list-contract";

const SETTLED_PAGE_SIZES = [10, 20, 50] as const;

export type TicketSearchParams = {
  page?: string | string[];
  pageSize?: string | string[];
  status?: string | string[];
  search?: string | string[];
  messagePage?: string | string[];
  messagePageSize?: string | string[];
};

export const TICKET_PAGINATION_NAMES = createPaginationUrlParamNames();
export const MESSAGE_PAGINATION_NAMES =
  createPaginationUrlParamNames("message");

/** 读取只出现一次的查询参数；重复值按非法输入处理。 */
function readSingle(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 把 Next.js searchParams 转为保留重复值语义的 URLSearchParams。 */
export function toUrlSearchParams(input: TicketSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "string") params.set(name, value);
    else if (Array.isArray(value)) {
      for (const item of value) params.append(name, item);
    }
  }
  return params;
}

/**
 * 解析工单列表查询状态。
 *
 * @param searchParams 公开 URL 查询参数。
 * @param paginationConfig 动态分页白名单。
 * @returns 可直接交给 UOL 的稳定分页与筛选输入。
 */
export function parseTicketListQuery(
  searchParams: TicketSearchParams,
  paginationConfig: PaginationConfig
): TicketListInput {
  const params = toUrlSearchParams(searchParams);
  const pagination = parsePaginationUrlState(
    params,
    TICKET_PAGINATION_NAMES,
    paginationConfig
  );
  const status = ticketStatusFilterSchema.safeParse(
    readSingle(searchParams.status)
  );
  const search = readSingle(searchParams.search)?.trim().slice(0, 200) ?? "";
  return {
    page: pagination.page,
    pageSize: normalizeSettledPageSize(pagination.pageSize),
    status: status.success ? status.data : "all",
    search,
  };
}

/** 解析工单详情页独立消息 namespace 的分页状态。 */
export function parseTicketMessageQuery(
  searchParams: TicketSearchParams,
  paginationConfig: PaginationConfig
) {
  const pagination = parsePaginationUrlState(
    toUrlSearchParams(searchParams),
    MESSAGE_PAGINATION_NAMES,
    paginationConfig
  );
  return {
    page: pagination.page,
    pageSize: normalizeSettledPageSize(pagination.pageSize),
  };
}

/** 收窄动态配置结果；本次产品改造只允许已确认的三档页大小。 */
function normalizeSettledPageSize(value: number): 10 | 20 | 50 {
  return SETTLED_PAGE_SIZES.includes(value as 10 | 20 | 50)
    ? (value as 10 | 20 | 50)
    : 20;
}

/** 构造改变工单筛选后回到第一页的 URL。 */
export function buildTicketCriteriaHref(
  pathname: string,
  searchParams: TicketSearchParams,
  criteria: Readonly<Record<string, string | null>>
): string {
  return buildPaginationHref(
    pathname,
    toUrlSearchParams(searchParams),
    TICKET_PAGINATION_NAMES,
    { criteria },
    "criteria"
  );
}

/** 构造改变列表或消息页大小后回到对应第一页的 URL。 */
export function buildTicketPageSizeHref(
  pathname: string,
  searchParams: TicketSearchParams,
  pageSize: number,
  namespace: "ticket" | "message"
): string {
  return buildPaginationHref(
    pathname,
    toUrlSearchParams(searchParams),
    namespace === "ticket" ? TICKET_PAGINATION_NAMES : MESSAGE_PAGINATION_NAMES,
    { pageSize },
    "criteria"
  );
}

/** 构造服务端越界收敛后的规范页码 URL。 */
export function buildTicketPageHref(
  pathname: string,
  searchParams: TicketSearchParams,
  page: number,
  namespace: "ticket" | "message"
): string {
  return buildPaginationHref(
    pathname,
    toUrlSearchParams(searchParams),
    namespace === "ticket" ? TICKET_PAGINATION_NAMES : MESSAGE_PAGINATION_NAMES,
    { page },
    "page"
  );
}
