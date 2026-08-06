/**
 * 旧“账单与用量”入口的纯重定向解析器。
 *
 * 使用方：旧 billing 路由。只保留安全支付展示上下文；不会加载账本、价格趋势
 * 或触发支付履约。非法参数直接丢弃，支付上下文优先于旧 usage 页签。
 */

import { isWalletPaymentResultStatus } from "@/features/wallet/redirects";

const PURCHASE_VALUES = ["top-up"] as const;

type LegacyBillingSearchParams = Record<string, string | string[] | undefined>;

/** 从 Next.js 查询参数中提取唯一字符串，数组值按不可信输入丢弃。 */
function getSingleSearchParam(
  searchParams: LegacyBillingSearchParams,
  key: string
): string | undefined {
  const value = searchParams[key];
  return typeof value === "string" ? value : undefined;
}

/** 判断字符串是否属于固定白名单，并为 TypeScript 收窄字面量类型。 */
function isAllowedValue<const T extends readonly string[]>(
  values: T,
  value: string | undefined
): value is T[number] {
  return Boolean(value && values.some((candidate) => candidate === value));
}

/**
 * 解析旧 billing 入口的新页面目标。
 *
 * @param searchParams 未信任的旧路由查询参数。
 * @returns dashboard 内相对目标；只携带 pay、success、purchase 白名单值。
 */
export function resolveLegacyBillingRedirect(
  searchParams: LegacyBillingSearchParams
): string {
  const tab = getSingleSearchParam(searchParams, "tab");
  const rawPay = getSingleSearchParam(searchParams, "pay");
  const normalizedPay = rawPay === "cancel" ? "canceled" : rawPay;
  const success = getSingleSearchParam(searchParams, "success");
  const purchase = getSingleSearchParam(searchParams, "purchase");
  const walletParams = new URLSearchParams();

  if (isWalletPaymentResultStatus(normalizedPay)) {
    walletParams.set("pay", normalizedPay);
  }
  if (success === "true") walletParams.set("success", "true");
  if (isAllowedValue(PURCHASE_VALUES, purchase)) {
    walletParams.set("purchase", purchase);
  }

  if (walletParams.size === 0 && tab === "usage") {
    return "/dashboard/history";
  }
  const query = walletParams.toString();
  return query ? `/dashboard/wallet?${query}` : "/dashboard/wallet";
}
