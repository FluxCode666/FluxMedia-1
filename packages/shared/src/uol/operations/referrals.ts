/** 推广域 UOL 操作注册：用户推广看板只读当前主体数据。 */
import { z } from "zod";
import { referralRewardConfigSchema } from "../../referrals/config";
import {
  referralRelationshipListInputSchema,
  referralRelationshipListOutputSchema,
} from "../../referrals/relationship-contract";
import { defineOperation } from "../registry";

export const referralDashboardOutputSchema = z
  .object({
    code: z.string(),
    inviteUrl: z.string().url(),
    invitedCount: z.number().int().nonnegative(),
    rewardedCount: z.number().int().nonnegative(),
    totalRewardCredits: z.number().nonnegative(),
    rewardConfig: referralRewardConfigSchema,
  })
  .strict();

export const getMyReferralDashboard = defineOperation({
  name: "referral.getMyDashboard",
  domain: "credits",
  title: "查询我的推广奖励",
  description:
    "读取当前用户推广码、邀请链接和当前奖励规则；不接受客户端 userId。",
  input: z.object({}).strict(),
  output: referralDashboardOutputSchema,
  access: { kind: "user" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: referral.getMyDashboard");
  },
});

/** 当前用户推广关系明细全量读取；仅供站内人工页面使用。 */
export const listMyReferralRelationships = defineOperation({
  name: "referral.listMyRelationships",
  domain: "credits",
  title: "查询我的全部推广关系",
  description:
    "按创建时间倒序读取当前用户的全部推广关系明细与精确总数；邮箱只返回脱敏值。",
  input: referralRelationshipListInputSchema,
  output: referralRelationshipListOutputSchema,
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: referral.listMyRelationships");
  },
});

const firstPaymentInputSchema = z
  .object({
    orderId: z.string().min(1).max(128),
    inviteeUserId: z.string().min(1).max(128),
    firstPaymentCredits: z.number().positive().max(1_000_000_000),
  })
  .strict();

const firstPaymentOutputSchema = z.discriminatedUnion("rewarded", [
  z.object({
    rewarded: z.literal(true),
    inviterRewardCredits: z.number().nonnegative(),
    inviteeRewardCredits: z.number().nonnegative(),
  }),
  z.object({
    rewarded: z.literal(false),
    reason: z.enum(["no_referral", "already_used", "disabled"]),
  }),
]);

/** 为单个支付渠道注册严格 webhook Principal 的首充奖励操作。 */
function defineFirstPaymentOperation(provider: "alipay" | "epay" | "creem") {
  return defineOperation({
    name: `referral.fulfillFirstPayment.${provider}`,
    domain: "credits",
    title: `履约 ${provider} 推广首充奖励`,
    description:
      "在主充值积分到账后幂等发放邀请人和新人奖励；首充抢占与两方积分批次均由数据库约束兜底。",
    input: firstPaymentInputSchema,
    output: firstPaymentOutputSchema,
    access: { kind: "webhook", provider },
    readOnly: false,
    destructive: false,
    idempotency: { kind: "required", keyField: "orderId", scope: "global" },
    sideEffects: ["billing"],
    execute: async () => {
      throw new Error(
        `Not yet wired: referral.fulfillFirstPayment.${provider}`
      );
    },
  });
}

export const fulfillAlipayReferralFirstPayment =
  defineFirstPaymentOperation("alipay");
export const fulfillEpayReferralFirstPayment =
  defineFirstPaymentOperation("epay");
export const fulfillCreemReferralFirstPayment =
  defineFirstPaymentOperation("creem");
