/**
 * 账号池成员与分组列表的 URL 状态契约。
 *
 * 使用方：ImageBackendPoolAdminPanel。两个列表使用独立 namespace，筛选与页大小
 * 变化回到第一页，同时保留设置页其他列表参数和当前账号池子页签。
 */

import type { PaginationConfig } from "@repo/shared/pagination/config";
import { parsePaginationState } from "@repo/shared/pagination/state";
import { createPaginationUrlParamNames } from "@repo/shared/pagination/url-adapter";
import type {
  AdminPoolGroupListInput,
  AdminPoolMemberListInput,
} from "@repo/shared/uol/operations/image-backend-pool";

import type { BackendMemberCredentialFilter } from "./admin-pool-view-model";

export const ADMIN_POOL_MEMBER_PAGINATION_NAMES =
  createPaginationUrlParamNames("member");
export const ADMIN_POOL_GROUP_PAGINATION_NAMES =
  createPaginationUrlParamNames("group");

export const ADMIN_POOL_TAB_PARAM = "poolTab";
export const ADMIN_POOL_MEMBER_FILTER_PARAMS = {
  name: "memberName",
  credentialStatus: "memberCredential",
  modelId: "memberModel",
  resolution: "memberResolution",
  createdFrom: "memberCreatedFrom",
  createdTo: "memberCreatedTo",
} as const;
export const ADMIN_POOL_GROUP_NAME_PARAM = "groupName";

const CREDENTIAL_FILTERS = new Set<BackendMemberCredentialFilter>([
  "all",
  "pending",
  "healthy",
  "degraded",
  "isolated",
  "overdue",
  "unhealthy",
  "not_applicable",
]);

/** 重复 URL 参数视为无效输入，避免前后端对筛选值取值不一致。 */
function readSingleValue(
  searchParams: URLSearchParams,
  name: string
): string | string[] | undefined {
  const values = searchParams.getAll(name);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

/** 只允许产品确认的 10、20、50 三档进入号池 UOL。 */
function normalizePoolPageSize(value: number): 10 | 20 | 50 {
  return value === 10 || value === 50 ? value : 20;
}

/** 截断单值筛选；重复值和非字符串恢复默认值。 */
function parseTextFilter(
  searchParams: URLSearchParams,
  name: string,
  maxLength: number
): string {
  const value = readSingleValue(searchParams, name);
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

/** 只接受 YYYY-MM-DD 日历日期，非法值不进入 operation。 */
function parseCalendarDate(
  searchParams: URLSearchParams,
  name: string
): string {
  const value = readSingleValue(searchParams, name);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : "";
}

/** 从当前 URL 解析严格的成员分页和筛选输入。 */
export function parseAdminPoolMemberListInput(
  searchParams: URLSearchParams,
  paginationConfig: PaginationConfig,
  timeZone: string
): AdminPoolMemberListInput {
  const state = parsePaginationState(
    {
      page: readSingleValue(
        searchParams,
        ADMIN_POOL_MEMBER_PAGINATION_NAMES.page
      ),
      pageSize: readSingleValue(
        searchParams,
        ADMIN_POOL_MEMBER_PAGINATION_NAMES.pageSize
      ),
    },
    paginationConfig
  );
  const credentialValue = readSingleValue(
    searchParams,
    ADMIN_POOL_MEMBER_FILTER_PARAMS.credentialStatus
  );
  const credentialStatus =
    typeof credentialValue === "string" &&
    CREDENTIAL_FILTERS.has(credentialValue as BackendMemberCredentialFilter)
      ? (credentialValue as BackendMemberCredentialFilter)
      : "all";
  const rawModelId = parseTextFilter(
    searchParams,
    ADMIN_POOL_MEMBER_FILTER_PARAMS.modelId,
    240
  );
  const rawResolution = parseTextFilter(
    searchParams,
    ADMIN_POOL_MEMBER_FILTER_PARAMS.resolution,
    32
  );

  return {
    page: state.page,
    pageSize: normalizePoolPageSize(state.pageSize),
    name: parseTextFilter(
      searchParams,
      ADMIN_POOL_MEMBER_FILTER_PARAMS.name,
      120
    ),
    credentialStatus,
    modelId: rawModelId || "all",
    resolution: rawResolution || "all",
    createdFrom: parseCalendarDate(
      searchParams,
      ADMIN_POOL_MEMBER_FILTER_PARAMS.createdFrom
    ),
    createdTo: parseCalendarDate(
      searchParams,
      ADMIN_POOL_MEMBER_FILTER_PARAMS.createdTo
    ),
    timeZone,
  };
}

/** 从当前 URL 解析严格的分组分页和名称输入。 */
export function parseAdminPoolGroupListInput(
  searchParams: URLSearchParams,
  paginationConfig: PaginationConfig
): AdminPoolGroupListInput {
  const state = parsePaginationState(
    {
      page: readSingleValue(
        searchParams,
        ADMIN_POOL_GROUP_PAGINATION_NAMES.page
      ),
      pageSize: readSingleValue(
        searchParams,
        ADMIN_POOL_GROUP_PAGINATION_NAMES.pageSize
      ),
    },
    paginationConfig
  );
  return {
    page: state.page,
    pageSize: normalizePoolPageSize(state.pageSize),
    name: parseTextFilter(searchParams, ADMIN_POOL_GROUP_NAME_PARAM, 120),
  };
}
