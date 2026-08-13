/**
 * 历史记录页面的公开 URL 状态解析与构造器。
 *
 * 使用方：历史记录服务端页面、筛选栏和 keyset 分页。只接受有界白名单参数；
 * 分页 cursor 由服务端签名并携带方向，URL 只保存当前页 cursor，避免深页 URL 增长。
 */

export const HISTORY_STATUS_FILTERS = [
  "processing",
  "queued",
  "in_progress",
  "completed",
  "failed",
] as const;

export const HISTORY_TYPE_FILTERS = ["image", "video"] as const;

export type HistoryStatusFilter = (typeof HISTORY_STATUS_FILTERS)[number];
export type HistoryTypeFilter = (typeof HISTORY_TYPE_FILTERS)[number];

/** Next.js 页面可接收的历史记录查询参数。 */
export type HistorySearchParams = Record<string, string | string[] | undefined>;

/** 页面使用的规范化筛选和当前签名 cursor。 */
export type HistoryQueryState = {
  createdFrom: string | null;
  createdTo: string | null;
  cursor: string | null;
  model: string | null;
  status: HistoryStatusFilter | null;
  type: HistoryTypeFilter | null;
  userEmail: string | null;
};

const MAX_CURSOR_LENGTH = 4096;
const MAX_MODEL_LENGTH = 240;
const MAX_USER_EMAIL_LENGTH = 320;

export type HistoryHrefOptions = {
  path?: string;
};

export type HistoryParseOptions = {
  allowUserEmail?: boolean;
};

/** 判断输入是否为真实存在的 ISO 日历日期。 */
function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 0) - 1 &&
    date.getUTCDate() === day
  );
}

/** 判断公开 URL 值是否是有界、可交由服务端二次校验的邮箱格式。 */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** 从不可信查询参数读取一个有界字符串；数组值不会隐式取首项。 */
function readScalar(
  value: string | string[] | undefined,
  maxLength: number
): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= maxLength ? value : null;
}

/** 判断字符串是否属于固定枚举。 */
function isOneOf<const T extends readonly string[]>(
  values: T,
  value: string | null
): value is T[number] {
  return value !== null && values.some((candidate) => candidate === value);
}

/**
 * 将公开 URL 参数收窄为历史列表输入。
 *
 * @param searchParams Next.js 原始查询参数。
 * @returns 非法字段被忽略后的规范化状态；反向日期交给表单显示错误。
 */
export function parseHistorySearchParams(
  searchParams: HistorySearchParams,
  options?: HistoryParseOptions
): HistoryQueryState {
  const createdFrom = readScalar(searchParams.createdFrom, 10);
  const createdTo = readScalar(searchParams.createdTo, 10);
  const model =
    readScalar(searchParams.model, MAX_MODEL_LENGTH)?.trim() || null;
  const status = readScalar(searchParams.status, 20);
  const type = readScalar(searchParams.type, 20);
  const userEmail =
    readScalar(searchParams.userEmail, MAX_USER_EMAIL_LENGTH)?.trim() || null;

  return {
    createdFrom:
      createdFrom && isIsoCalendarDate(createdFrom) ? createdFrom : null,
    createdTo: createdTo && isIsoCalendarDate(createdTo) ? createdTo : null,
    cursor: readScalar(searchParams.cursor, MAX_CURSOR_LENGTH),
    model,
    status: isOneOf(HISTORY_STATUS_FILTERS, status) ? status : null,
    type: isOneOf(HISTORY_TYPE_FILTERS, type) ? type : null,
    userEmail:
      options?.allowUserEmail && userEmail && isEmail(userEmail)
        ? userEmail
        : null,
  };
}

/** 将筛选和 keyset 状态构造成 next-intl 可接收的无语言前缀 URL。 */
export function buildHistoryHref(
  state: HistoryQueryState,
  options?: HistoryHrefOptions
): string {
  const searchParams = new URLSearchParams();
  if (state.createdFrom) searchParams.set("createdFrom", state.createdFrom);
  if (state.createdTo) searchParams.set("createdTo", state.createdTo);
  if (state.model) searchParams.set("model", state.model);
  if (state.status) searchParams.set("status", state.status);
  if (state.type) searchParams.set("type", state.type);
  if (state.userEmail) searchParams.set("userEmail", state.userEmail);
  if (state.cursor) searchParams.set("cursor", state.cursor);
  const query = searchParams.toString();
  const path = options?.path ?? "/dashboard/history";
  return query ? `${path}?${query}` : path;
}

/** 构造下一页 URL；cursor 方向和边界由服务端签名。 */
export function buildNextHistoryHref(
  state: HistoryQueryState,
  nextCursor: string,
  options?: HistoryHrefOptions
): string {
  return buildHistoryHref(
    {
      ...state,
      cursor: nextCursor,
    },
    options
  );
}

/** 构造上一页 URL；previousCursor 由服务端针对当前结果页签发。 */
export function buildPreviousHistoryHref(
  state: HistoryQueryState,
  previousCursor: string,
  options?: HistoryHrefOptions
): string {
  return buildHistoryHref(
    {
      ...state,
      cursor: previousCursor,
    },
    options
  );
}

/** 判断当前状态是否包含用户可见筛选，不把分页 cursor 视为筛选。 */
export function hasActiveHistoryFilters(state: HistoryQueryState): boolean {
  return Boolean(
    state.createdFrom ||
      state.createdTo ||
      state.model ||
      state.status ||
      state.type ||
      state.userEmail
  );
}
