/**
 * 管理端支付页面公开 URL 状态解析与构造器。
 *
 * 使用方：支付概览页、订单管理页及客户端筛选/分页控件。只接受有界白名单参数，
 * 任一筛选变化都会清除签名 cursor，防止跨筛选复用。
 */
import {
  ADMIN_PAYMENT_ORDER_STATUSES,
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

/** 解析支付概览的可选 YYYY-MM；非法或数组值回退当前月。 */
export function parseAdminPaymentMonth(
  searchParams: AdminPaymentSearchParams
): string | null {
  const month = readScalar(searchParams.month, 7);
  return month && /^20\d{2}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
}

/** 将自然月构造成支付概览 URL。 */
export function buildAdminPaymentOverviewHref(month: string): string {
  return `/dashboard/admin/payments?month=${encodeURIComponent(month)}`;
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
