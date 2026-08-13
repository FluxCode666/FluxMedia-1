/**
 * 跨包可复用的 namespaced 分页 URL adapter。
 *
 * 使用方：apps/web 与 packages/shared 中的客户端管理列表。仅依赖 URLSearchParams
 * 和分页状态，不读取 Next.js 路由或浏览器全局。
 */
import type { PaginationConfig } from "./config";
import { type PaginationState, parsePaginationState } from "./state";

export type PaginationUrlParamNames = {
  page: string;
  pageSize: string;
  cursor?: string;
};

export type PaginationUrlState = PaginationState & {
  cursor: string | null;
};

export type PaginationUrlUpdate = {
  page?: number;
  pageSize?: number;
  cursor?: string | null;
  criteria?: Readonly<Record<string, string | null>>;
};

export type PaginationUrlUpdateMode = "page" | "criteria";

/** 为单列表或多列表页面建立显式参数名。 */
export function createPaginationUrlParamNames(
  namespace = ""
): PaginationUrlParamNames {
  return {
    page: namespace ? `${namespace}Page` : "page",
    pageSize: namespace ? `${namespace}PageSize` : "pageSize",
    cursor: namespace ? `${namespace}Cursor` : "cursor",
  };
}

/** 从 URLSearchParams 读取严格分页状态。 */
export function parsePaginationUrlState(
  searchParams: URLSearchParams,
  names: PaginationUrlParamNames,
  config: PaginationConfig
): PaginationUrlState {
  const state = parsePaginationState(
    {
      page: readSingleValue(searchParams, names.page),
      pageSize: readSingleValue(searchParams, names.pageSize),
    },
    config
  );
  const rawCursor = names.cursor
    ? readSingleValue(searchParams, names.cursor)
    : undefined;

  return {
    ...state,
    cursor:
      typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : null,
  };
}

/**
 * 构造保留同页其他 namespace 的分页 URL。
 *
 * @param pathname - 不含 query 的绝对站内路径。
 * @param searchParams - 当前查询参数；函数会克隆而不修改调用方对象。
 * @param names - 当前列表归属的参数名。
 * @param update - 当前列表分页状态或筛选变更。
 * @param mode - page 只翻页；criteria 清边界回首页。
 * @returns 稳定排序且完成默认页码省略的站内 href。
 */
export function buildPaginationHref(
  pathname: string,
  searchParams: URLSearchParams,
  names: PaginationUrlParamNames,
  update: PaginationUrlUpdate,
  mode: PaginationUrlUpdateMode
): string {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new Error("分页 pathname 必须是绝对站内路径");
  }
  const next = new URLSearchParams(searchParams);

  for (const [name, value] of Object.entries(update.criteria ?? {})) {
    if (value === null || value.length === 0) next.delete(name);
    else next.set(name, value);
  }

  if (mode === "criteria") {
    setPositiveInteger(next, names.page, 1, 1);
    if (names.cursor) next.delete(names.cursor);
  }
  if (update.page !== undefined && mode === "page") {
    setPositiveInteger(next, names.page, update.page, 1);
  }
  if (update.pageSize !== undefined) {
    setPositiveInteger(next, names.pageSize, update.pageSize);
    if (mode === "criteria") {
      setPositiveInteger(next, names.page, 1, 1);
      if (names.cursor) next.delete(names.cursor);
    }
  }
  if (names.cursor && update.cursor !== undefined && mode === "page") {
    if (update.cursor) next.set(names.cursor, update.cursor);
    else next.delete(names.cursor);
  }

  next.sort();
  const query = next.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
}

/** 重复参数视为篡改并交由默认值恢复。 */
function readSingleValue(
  searchParams: URLSearchParams,
  name: string
): string | string[] | undefined {
  const values = searchParams.getAll(name);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

/** 写入安全正整数，并在命中可选默认值时省略参数。 */
function setPositiveInteger(
  searchParams: URLSearchParams,
  name: string,
  value: number,
  defaultValue?: number
): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是安全的正整数`);
  }
  if (value === defaultValue) searchParams.delete(name);
  else searchParams.set(name, String(value));
}
