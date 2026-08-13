/**
 * 公告页公开 URL 状态解析与链接构造。
 *
 * 使用方：用户公告页、管理公告页、页大小和发布状态筛选控件。只接受固定
 * 10/20/50 页大小与发布状态枚举，筛选或页大小变化会回到第一页。
 */
import {
  type AdminAnnouncementPublishedFilter,
  adminAnnouncementPublishedFilters,
  announcementListPageSizes,
} from "@repo/shared/announcements/list-contract";
import { parsePaginationConfig } from "@repo/shared/pagination/config";
import { parsePaginationState } from "@repo/shared/pagination/state";

export type AnnouncementSearchParams = Record<
  string,
  string | string[] | undefined
>;

export type AnnouncementPaginationState = {
  page: number;
  pageSize: (typeof announcementListPageSizes)[number];
};

export type AdminAnnouncementQueryState = AnnouncementPaginationState & {
  published: AdminAnnouncementPublishedFilter;
};

const paginationConfig = parsePaginationConfig(announcementListPageSizes);

/** 从不可信 URL 读取公告页码和固定页大小。 */
export function parseAnnouncementPagination(
  searchParams: AnnouncementSearchParams
): AnnouncementPaginationState {
  const pagination = parsePaginationState(
    { page: searchParams.page, pageSize: searchParams.pageSize },
    paginationConfig
  );
  return {
    page: pagination.page,
    pageSize: pagination.pageSize as AnnouncementPaginationState["pageSize"],
  };
}

/** 从不可信 URL 读取管理公告分页和发布状态筛选。 */
export function parseAdminAnnouncementQuery(
  searchParams: AnnouncementSearchParams
): AdminAnnouncementQueryState {
  const pagination = parseAnnouncementPagination(searchParams);
  const rawPublished = searchParams.published;
  const published: AdminAnnouncementPublishedFilter =
    typeof rawPublished === "string" &&
    adminAnnouncementPublishedFilters.some(
      (candidate) => candidate === rawPublished
    )
      ? (rawPublished as AdminAnnouncementPublishedFilter)
      : "all";
  return { ...pagination, published };
}

/** 构造用户公告列表的规范站内 URL。 */
export function buildAnnouncementHref(
  state: AnnouncementPaginationState,
  path = "/dashboard/announcements"
): string {
  const searchParams = new URLSearchParams();
  if (state.page > 1) searchParams.set("page", String(state.page));
  if (state.pageSize !== 20) {
    searchParams.set("pageSize", String(state.pageSize));
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

/** 构造管理公告列表 URL；发布筛选与页大小变更由调用方传入 page=1。 */
export function buildAdminAnnouncementHref(
  state: AdminAnnouncementQueryState
): string {
  const base = buildAnnouncementHref(state, "/dashboard/admin/announcements");
  const [path, rawQuery = ""] = base.split("?");
  const searchParams = new URLSearchParams(rawQuery);
  if (state.published !== "all") {
    searchParams.set("published", state.published);
  }
  searchParams.sort();
  const query = searchParams.toString();
  return query
    ? `${path}?${query}`
    : (path ?? "/dashboard/admin/announcements");
}
