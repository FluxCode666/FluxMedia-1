/**
 * 支付基础配置。
 *
 * 使用方：一次性充值、退款和支付回调。本模块只保留支付提供商、货币和站点回调
 * 地址等与按量计费相关的配置。
 */

import type { RuntimePaymentProvider } from "../payment/provider-policy";

const configuredPaymentProviders = [
  process.env.PAYMENT_PROVIDER,
  process.env.NEXT_PUBLIC_PAYMENT_PROVIDER,
]
  .map((value) => value?.trim().toLowerCase())
  .filter((value): value is string => Boolean(value));

/**
 * 读取部署时的默认支付提供商。
 *
 * 参数：无。
 * 返回：合法的运行时支付提供商；未知值回退到 none。
 * 副作用：读取进程环境变量；不写入数据库。
 */
export const paymentProvider: RuntimePaymentProvider =
  configuredPaymentProviders.includes("none")
    ? "none"
    : configuredPaymentProviders.includes("alipay_f2f")
      ? "alipay_f2f"
      : configuredPaymentProviders.includes("epay")
        ? "epay"
        : configuredPaymentProviders.includes("creem") ||
            configuredPaymentProviders.length === 0
          ? "creem"
          : "none";

/**
 * 与支付金额和订单快照相关的基础配置。
 *
 * 仅包含一次性充值所需字段，避免支付配置携带周期业务状态。
 */
export const paymentConfig = {
  provider: paymentProvider,
  currency: "CNY",
  redirectAfterCheckout: "/dashboard/wallet",
  redirectAfterCancel: "/dashboard/wallet",
} as const;

/**
 * 获取应用的基础 URL。
 *
 * 参数：无。
 * 返回：用于支付回调和站内跳转的绝对 URL。
 * 副作用：读取进程环境变量；本地开发时返回 localhost。
 */
export function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}
