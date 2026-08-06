/**
 * 钱包支付回跳目标生成器。
 *
 * 使用方：Epay 同步回跳路由。所有目标只由服务端 base URL
 * 生成，不接受客户端 URL，避免开放重定向和跨站回跳。
 */
import { getBaseUrl } from "@repo/shared/config/payment";

const WALLET_PATH = "/dashboard/wallet";
const PAYMENT_RESULT_STATUSES = [
  "success",
  "canceled",
  "processing",
  "pending",
  "fail",
] as const;

export type WalletPaymentResultStatus =
  (typeof PAYMENT_RESULT_STATUSES)[number];

/** 判断不可信值是否属于钱包允许展示的支付结果。 */
export function isWalletPaymentResultStatus(
  value: unknown
): value is WalletPaymentResultStatus {
  return (
    typeof value === "string" &&
    PAYMENT_RESULT_STATUSES.some((allowed) => allowed === value)
  );
}

/**
 * 解析可信应用源并丢弃 base URL 中的路径、查询与片段。
 *
 * @param baseUrl 服务端配置的应用基础 URL。
 * @returns 仅含 http/https scheme 与 host 的 origin。
 * @throws URL 非法或不是 http/https 时拒绝生成支付目标。
 */
function resolveApplicationOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("应用基础 URL 必须使用 http 或 https");
  }
  return url.origin;
}

/**
 * 生成 Epay 校验后的钱包结果 URL，只接受固定状态白名单。
 *
 * @param status 支付展示状态；未知值不会进入查询参数。
 * @param baseUrl 服务端基础 URL，默认读取部署配置。
 * @returns 同源钱包绝对 URL，不执行任何履约或发放。
 */
export function createWalletPaymentResultUrl(
  status: unknown,
  baseUrl = getBaseUrl()
): string {
  const origin = resolveApplicationOrigin(baseUrl);
  const url = new URL(WALLET_PATH, origin);
  if (isWalletPaymentResultStatus(status)) {
    url.searchParams.set("pay", status);
  }
  return url.toString();
}
