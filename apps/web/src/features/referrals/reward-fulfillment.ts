/**
 * 支付履约到推广 UOL 的内部薄适配器。
 *
 * 使用方：支付宝、易支付和 Creem 已验签履约服务。调用方只传冻结的订单快照；
 * provider 决定固定 operation 与 webhook Principal，不能由外部未验签输入直达。
 */
import { invokeOperation } from "@repo/shared/uol";
import {
  fulfillAlipayReferralFirstPayment,
  fulfillCreemReferralFirstPayment,
  fulfillEpayReferralFirstPayment,
} from "@repo/shared/uol/operations/referrals";
import type { Principal } from "@repo/shared/uol/principal";
import { ensureUolInitialized } from "@/server/uol-init";

const referralOperations = {
  alipay: fulfillAlipayReferralFirstPayment,
  epay: fulfillEpayReferralFirstPayment,
  creem: fulfillCreemReferralFirstPayment,
} as const;

type ReferralPaymentProvider = keyof typeof referralOperations;
type WebhookPrincipal = Extract<Principal, { type: "webhook" }>;

export type ReferralFirstPaymentInvoker = (
  name: string,
  input: {
    orderId: string;
    inviteeUserId: string;
    firstPaymentCredits: number;
  },
  principal: WebhookPrincipal
) => Promise<unknown>;

/** 通过统一网关调用渠道隔离的首充奖励 operation。 */
export async function invokeReferralFirstPayment(
  input: {
    provider: ReferralPaymentProvider;
    orderId: string;
    inviteeUserId: string;
    firstPaymentCredits: number;
  },
  dependencies: {
    initialize?: () => Promise<void>;
    invoke?: ReferralFirstPaymentInvoker;
  } = {}
) {
  await (dependencies.initialize ?? ensureUolInitialized)();
  const operation = referralOperations[input.provider];
  return (dependencies.invoke ?? invokeOperation)(
    operation.name,
    {
      orderId: input.orderId,
      inviteeUserId: input.inviteeUserId,
      firstPaymentCredits: input.firstPaymentCredits,
    },
    { type: "webhook", provider: input.provider }
  );
}
