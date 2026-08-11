/**
 * 管理端数据看板 URL 适配。
 *
 * 复用用户看板的 strict 日期类型并增加稳定 userId，确保管理员深链不会把邮箱、
 * 名称或未知筛选参数传入 UOL。
 */
import {
  type AdminDataDashboardInput,
  type DataDashboardInput,
  adminDataDashboardInputSchema,
} from "@repo/shared/analytics/contracts";

import {
  parseDataDashboardSearchParams,
  type DataDashboardSearchParams,
} from "./data-dashboard-query";

export type AdminDataDashboardSearchParams = DataDashboardSearchParams;

/** 解析管理员数据看板 URL query，非法深链回退动态默认七天。 */
export function parseAdminDataDashboardSearchParams(
  params: AdminDataDashboardSearchParams
): { input: AdminDataDashboardInput; invalidDeepLink: boolean } {
  const keys = Object.keys(params);
  if (keys.length === 0) return parseDataDashboardSearchParams(params);
  if (
    keys.some(
      (key) => key !== "startDate" && key !== "endDate" && key !== "userId"
    ) ||
    (params.startDate !== undefined && typeof params.startDate !== "string") ||
    (params.endDate !== undefined && typeof params.endDate !== "string") ||
    (params.userId !== undefined && typeof params.userId !== "string")
  ) {
    return { input: {}, invalidDeepLink: true } as const;
  }
  const input = {
    ...(typeof params.startDate === "string"
      ? { startDate: params.startDate }
      : {}),
    ...(typeof params.endDate === "string" ? { endDate: params.endDate } : {}),
    ...(typeof params.userId === "string" ? { userId: params.userId } : {}),
  };
  const parsed = adminDataDashboardInputSchema.safeParse(input);
  return parsed.success
    ? { input: parsed.data, invalidDeepLink: false }
    : { input: {}, invalidDeepLink: true };
}

/** 从管理员组合筛选中提取不含身份字段的 strict 日期输入。 */
export function selectAdminDataDashboardRangeInput(
  input: AdminDataDashboardInput
): DataDashboardInput {
  return "startDate" in input
    ? { startDate: input.startDate, endDate: input.endDate }
    : {};
}

/** 构造管理员数据看板 canonical 路径。 */
export function buildAdminDataDashboardHref(
  input: AdminDataDashboardInput
): string {
  const search = new URLSearchParams();
  if ("startDate" in input) {
    search.set("startDate", input.startDate);
    search.set("endDate", input.endDate);
  }
  if ("userId" in input && input.userId) search.set("userId", input.userId);
  const query = search.toString();
  return query
    ? `/dashboard/admin/analytics?${query}`
    : "/dashboard/admin/analytics";
}
