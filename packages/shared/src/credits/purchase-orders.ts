/** Shared payment result types and display helpers. Persistence belongs to Go. */
export type CreditPackagePaymentProvider = "creem" | "epay";

export type CreditPaymentDisplayStatus =
  | "waiting_payment"
  | "payment_confirmed"
  | "fulfilled"
  | "failed"
  | "expired";

export type CreditPackagePricingSnapshot = {
  packageId: string;
  quantity: number;
  currency: string;
  amountMinor: number;
  creditsAmount: number;
  creditsExpiresAt: string | null;
};

export type CreditPackagePaymentOrder = {
  id: string;
  userId: string;
  provider: CreditPackagePaymentProvider;
  status: string;
  currency: string;
  amount: number;
  amountMinor: number;
  creditsAmount: number;
  expiresAt: Date | null;
  fulfilledAt: Date | null;
  providerPayload: Record<string, unknown> | null;
  providerTradeNo: string | null;
};

export function getCreditPackageCheckoutUrl(
  payload: Record<string, unknown> | null
): string | null {
  const checkoutUrl = payload?.checkoutUrl;
  return typeof checkoutUrl === "string" && checkoutUrl ? checkoutUrl : null;
}

/**
 * 将持久化状态映射为面向用户的状态。
 *
 * `expiresAt` 只控制界面上的重试提示，不能作为拒绝已验签支付通知的依据；
 * 支付平台可能在过期前完成交易、通知却延迟到达，服务端仍必须如实履约。
 */
export function getCreditPaymentDisplayStatus(input: {
  status: string;
  expiresAt: Date | null;
  now?: Date;
}): CreditPaymentDisplayStatus {
  if (input.status === "fulfilled") return "fulfilled";
  if (input.status === "failed") return "failed";
  if (input.status === "fulfilling") return "payment_confirmed";
  if (
    input.expiresAt &&
    input.expiresAt.getTime() <= (input.now ?? new Date()).getTime()
  ) {
    return "expired";
  }
  return "waiting_payment";
}
