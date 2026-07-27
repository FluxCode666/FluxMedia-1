/**
 * 管理端支付页面公开 URL 状态解析与构造器。
 *
 * 使用方：支付概览页、订单管理页及客户端筛选/分页控件。只接受有界白名单参数，
 * 任一筛选变化都会清除签名 cursor，防止跨筛选复用。
 */
import {
  ADMIN_PAYMENT_ORDER_STATUSES,
  ADMIN_PAYMENT_OVERVIEW_MAX_DAYS,
  type AdminPaymentOrderStatus,
} from "@repo/shared/payment/admin-contract";

export type AdminPaymentSearchParams = Record<
  string,
  string | string[] | undefined
>;

export type AdminPaymentOrderQueryState = {
  cursor: string | null;
  orderId: string | null;
  status: AdminPaymentOrderStatus | null;
  userEmail: string | null;
};

export type AdminPaymentOverviewRange = {
  startDate: string;
  endDate: string;
};

const MAX_CURSOR_LENGTH = 4096;
const MAX_ORDER_ID_LENGTH = 128;
const MAX_USER_EMAIL_LENGTH = 320;

/** 从不可信查询参数读取一个有界标量；数组不会隐式取首项。 */
function readScalar(
  value: string | string[] | undefined,
  maxLength: number
): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

/** 判断字符串是否属于持久支付状态白名单。 */
function isPaymentOrderStatus(
  value: string | null
): value is AdminPaymentOrderStatus {
  return (
    value !== null &&
    ADMIN_PAYMENT_ORDER_STATUSES.some((candidate) => candidate === value)
  );
}

/** 判断邮箱是否可交给 UOL 进行二次严格校验。 */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** 将 YYYY-MM-DD 校验并转换为 UTC 日历日序号。 */
function getCalendarDayNumber(value: string): number | null {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const time = Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0);
  const date = new Date(time);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 0) - 1 &&
    date.getUTCDate() === day
    ? Math.floor(time / 86_400_000)
    : null;
}

/** 解析支付概览的成对日期范围；非法、缺失一端或超限时回退默认范围。 */
export function parseAdminPaymentDateRange(
  searchParams: AdminPaymentSearchParams
): AdminPaymentOverviewRange | null {
  const startDate = readScalar(searchParams.startDate, 10);
  const endDate = readScalar(searchParams.endDate, 10);
  if (!startDate || !endDate) return null;
  const startDay = getCalendarDayNumber(startDate);
  const endDay = getCalendarDayNumber(endDate);
  if (
    startDay === null ||
    endDay === null ||
    startDay > endDay ||
    endDay - startDay + 1 > ADMIN_PAYMENT_OVERVIEW_MAX_DAYS
  ) {
    return null;
  }
  return { startDate, endDate };
}

/** 将日期范围构造成不含语言前缀的支付概览 URL。 */
export function buildAdminPaymentOverviewHref(
  range: AdminPaymentOverviewRange
): string {
  const searchParams = new URLSearchParams({
    startDate: range.startDate,
    endDate: range.endDate,
  });
  return `/dashboard/admin/payments?${searchParams.toString()}`;
}

/** 根据任一合法日历日期构造其完整自然月范围。 */
export function buildCalendarMonthRange(
  calendarDate: string
): AdminPaymentOverviewRange {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(calendarDate)) {
    throw new RangeError("Invalid calendar date");
  }
  const [year, month, day] = calendarDate.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== (month ?? 0) - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError("Invalid calendar date");
  }
  const monthPrefix = calendarDate.slice(0, 7);
  const monthEnd = new Date(Date.UTC(year ?? 0, month ?? 0, 0));
  return {
    startDate: `${monthPrefix}-01`,
    endDate: `${monthPrefix}-${String(monthEnd.getUTCDate()).padStart(2, "0")}`,
  };
}

/** 将订单列表 URL 参数收窄为稳定筛选和 cursor 状态。 */
export function parseAdminPaymentOrderQuery(
  searchParams: AdminPaymentSearchParams
): AdminPaymentOrderQueryState {
  const orderId =
    readScalar(searchParams.orderId, MAX_ORDER_ID_LENGTH)?.trim() || null;
  const userEmail =
    readScalar(searchParams.userEmail, MAX_USER_EMAIL_LENGTH)?.trim() || null;
  const status = readScalar(searchParams.status, 20);
  return {
    cursor: readScalar(searchParams.cursor, MAX_CURSOR_LENGTH),
    orderId,
    status: isPaymentOrderStatus(status) ? status : null,
    userEmail: userEmail && isEmail(userEmail) ? userEmail : null,
  };
}

/** 构造不含语言前缀的订单管理 URL。 */
export function buildAdminPaymentOrdersHref(
  state: AdminPaymentOrderQueryState
): string {
  const searchParams = new URLSearchParams();
  if (state.userEmail) searchParams.set("userEmail", state.userEmail);
  if (state.orderId) searchParams.set("orderId", state.orderId);
  if (state.status) searchParams.set("status", state.status);
  if (state.cursor) searchParams.set("cursor", state.cursor);
  const query = searchParams.toString();
  return query
    ? `/dashboard/admin/payments/orders?${query}`
    : "/dashboard/admin/payments/orders";
}

/** 判断订单列表是否包含用户可见筛选，不把分页 cursor 计作筛选。 */
export function hasAdminPaymentOrderFilters(
  state: AdminPaymentOrderQueryState
): boolean {
  return Boolean(state.userEmail || state.orderId || state.status);
}
