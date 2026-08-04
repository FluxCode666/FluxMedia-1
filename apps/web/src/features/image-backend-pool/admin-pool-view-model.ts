/**
 * 账号池管理列表的纯筛选视图模型。
 *
 * 使用方：账号池管理面板及其 DB-free 单测。本模块只消费已脱敏的分组、成员快照，
 * 统一名称模糊匹配、凭据状态归一、模型精确匹配和部署时区自然日范围，不访问浏览器
 * 或数据库，也不改变服务端返回顺序。
 */
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";

import type { BackendMemberAdminSummary } from "./member-service";

/** 管理列表可选的统一凭据状态。 */
export type BackendMemberCredentialFilter =
  | "all"
  | "configured"
  | "not_required"
  | "missing"
  | "active"
  | "error"
  | "exhausted"
  | "invalid";

/** 供应商账号列表的全部筛选条件。 */
export interface BackendMemberFilters {
  name: string;
  credentialStatus: BackendMemberCredentialFilter;
  modelId: string;
  createdFrom: string;
  createdTo: string;
}

/** 供应商账号筛选器的稳定空值。 */
export const EMPTY_BACKEND_MEMBER_FILTERS: BackendMemberFilters = {
  name: "",
  credentialStatus: "all",
  modelId: "all",
  createdFrom: "",
  createdTo: "",
};

/** 把用户输入与模型 ID 规范为大小写无关的匹配键。 */
function normalizeFilterValue(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

/**
 * 将供应商账号映射为互斥的统一凭据状态。
 *
 * @param member 已脱敏的供应商账号摘要。
 * @returns API 无认证明确返回 not_required；Adobe Direct 保留领域状态；其余按密钥
 * 存在性返回 configured 或 missing。
 * @sideEffects 无。
 * @failure 不抛错；旧 API 摘要缺少 authentication 时仍按需要密钥处理。
 */
export function getBackendMemberCredentialStatus(
  member: BackendMemberAdminSummary
): Exclude<BackendMemberCredentialFilter, "all"> {
  if (member.type === "api" && member.config.authentication?.mode === "none") {
    return "not_required";
  }
  if (member.type === "api") {
    return member.config.hasApiKey ? "configured" : "missing";
  }
  if (member.config.mode === "direct") {
    return member.config.credentialStatus;
  }
  return member.config.hasApiKey ? "configured" : "missing";
}

/**
 * 将 ISO 时间格式化为指定时区的 YYYY-MM-DD 日历键。
 *
 * @param value 服务端严格输出的 ISO 创建时间。
 * @param formatter 已绑定部署时区的格式化器。
 * @returns 可按字典序比较的日期键；非法时间返回 null。
 * @sideEffects 无。
 */
function formatCalendarDateKey(
  value: string,
  formatter: Intl.DateTimeFormat
): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/**
 * 构造部署时区日期格式化器；非法时区仅作为防御性边界回退 UTC。
 *
 * @param timeZone 管理设置页使用的 IANA 时区。
 * @returns 固定两位月日的日期格式化器。
 * @sideEffects 无。
 */
function createCalendarDateFormatter(timeZone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  };
  try {
    return new Intl.DateTimeFormat("en-CA", options);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      ...options,
      timeZone: "UTC",
    });
  }
}

/** 判断供应商账号筛选是否包含任一有效条件。 */
export function hasBackendMemberFilters(
  filters: BackendMemberFilters
): boolean {
  return (
    Boolean(filters.name.trim()) ||
    filters.credentialStatus !== "all" ||
    filters.modelId !== "all" ||
    Boolean(filters.createdFrom) ||
    Boolean(filters.createdTo)
  );
}

/** 判断创建日期起点是否晚于终点。 */
export function hasInvalidBackendMemberDateRange(
  filters: Pick<BackendMemberFilters, "createdFrom" | "createdTo">
): boolean {
  return Boolean(
    filters.createdFrom &&
      filters.createdTo &&
      filters.createdFrom > filters.createdTo
  );
}

/**
 * 按名称、凭据状态、支持模型和部署时区创建日期筛选供应商账号。
 *
 * @param members 服务端已按调度优先级排序的脱敏账号快照。
 * @param filters 当前受控筛选条件。
 * @param timeZone 管理设置页的部署时区。
 * @returns 保持输入顺序的匹配账号；非法日期范围明确返回空数组。
 * @sideEffects 无。
 */
export function filterBackendMembers(
  members: readonly BackendMemberAdminSummary[],
  filters: BackendMemberFilters,
  timeZone: string
): BackendMemberAdminSummary[] {
  if (hasInvalidBackendMemberDateRange(filters)) return [];
  const name = normalizeFilterValue(filters.name);
  const modelId = normalizeFilterValue(filters.modelId);
  const hasDateFilter = Boolean(filters.createdFrom || filters.createdTo);
  const dateFormatter = hasDateFilter
    ? createCalendarDateFormatter(timeZone)
    : null;

  return members.filter((member) => {
    if (name && !normalizeFilterValue(member.name).includes(name)) {
      return false;
    }
    if (
      filters.credentialStatus !== "all" &&
      getBackendMemberCredentialStatus(member) !== filters.credentialStatus
    ) {
      return false;
    }
    if (
      filters.modelId !== "all" &&
      !member.supportedModelIds.some(
        (supportedModelId) => normalizeFilterValue(supportedModelId) === modelId
      )
    ) {
      return false;
    }
    if (!dateFormatter) return true;
    const createdDate = formatCalendarDateKey(member.createdAt, dateFormatter);
    if (!createdDate) return false;
    if (filters.createdFrom && createdDate < filters.createdFrom) return false;
    if (filters.createdTo && createdDate > filters.createdTo) return false;
    return true;
  });
}

/** 判断分组名称搜索是否包含有效条件。 */
export function hasBackendGroupFilter(name: string): boolean {
  return Boolean(name.trim());
}

/**
 * 按名称进行大小写无关的分组模糊搜索。
 *
 * @param groups 服务端分组快照。
 * @param name 用户输入的名称片段。
 * @returns 保持输入顺序的匹配分组。
 * @sideEffects 无。
 */
export function filterBackendGroups(
  groups: readonly BackendGroupSummary[],
  name: string
): BackendGroupSummary[] {
  const normalizedName = normalizeFilterValue(name);
  if (!normalizedName) return [...groups];
  return groups.filter((group) =>
    normalizeFilterValue(group.name).includes(normalizedName)
  );
}
