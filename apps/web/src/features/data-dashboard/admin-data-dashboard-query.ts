/**
 * 管理端数据看板 URL 适配。
 *
 * 复用用户看板的 strict 日期解析，仅替换 canonical 路径，确保管理员深链不会把
 * 身份字段或未知筛选参数传入 UOL。
 */
import type { DataDashboardInput } from "@repo/shared/analytics/contracts";

import {
  buildDataDashboardHref,
  parseDataDashboardSearchParams,
  type DataDashboardSearchParams,
} from "./data-dashboard-query";

export type AdminDataDashboardSearchParams = DataDashboardSearchParams;

/** 解析管理员数据看板 URL query，非法深链回退动态默认七天。 */
export function parseAdminDataDashboardSearchParams(
  params: AdminDataDashboardSearchParams
) {
  return parseDataDashboardSearchParams(params);
}

/** 构造管理员数据看板 canonical 路径。 */
export function buildAdminDataDashboardHref(input: DataDashboardInput) {
  return buildDataDashboardHref(input, "/dashboard/admin/analytics");
}
