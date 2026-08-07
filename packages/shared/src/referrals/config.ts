/**
 * 推广奖励配置与计算契约。
 *
 * 使用方：系统设置页、首充履约服务和 DB-free 单测。奖励单位统一为 Credits；比例
 * 基于新人首充订单冻结的 creditsAmount 计算，固定模式直接发放固定 Credits。
 */
import { z } from "zod";

export const REFERRAL_REWARD_CONFIG_SETTING_KEY =
  "REFERRAL_REWARD_CONFIG" as const;

export const REFERRAL_REWARD_PERCENTAGE_MAX = 100;
export const REFERRAL_REWARD_FIXED_MAX = 1_000_000;

export const referralRewardSideSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("percentage"),
    value: z.number().min(0).max(REFERRAL_REWARD_PERCENTAGE_MAX),
  }),
  z.object({
    mode: z.literal("fixed"),
    value: z.number().min(0).max(REFERRAL_REWARD_FIXED_MAX),
  }),
]);

export const referralRewardConfigSchema = z
  .object({
    enabled: z.boolean(),
    inviter: referralRewardSideSchema,
    invitee: referralRewardSideSchema,
  })
  .strict();

export type ReferralRewardSide = z.infer<typeof referralRewardSideSchema>;
export type ReferralRewardMode = ReferralRewardSide["mode"];
export type ReferralRewardConfig = z.infer<typeof referralRewardConfigSchema>;

export const DEFAULT_REFERRAL_REWARD_CONFIG: ReferralRewardConfig = {
  enabled: false,
  inviter: { mode: "percentage", value: 10 },
  invitee: { mode: "percentage", value: 10 },
};

function finiteNonNegative(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeSide(value: unknown, fallback: ReferralRewardSide) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const candidate = value as Record<string, unknown>;
  const mode = candidate.mode === "fixed" ? "fixed" : "percentage";
  return {
    mode,
    value: Math.min(
      finiteNonNegative(candidate.value, fallback.value),
      mode === "fixed"
        ? REFERRAL_REWARD_FIXED_MAX
        : REFERRAL_REWARD_PERCENTAGE_MAX
    ),
  } satisfies ReferralRewardSide;
}

/** 将后台 JSON、环境变量或历史脏值收敛为安全的运行时配置。 */
export function normalizeReferralRewardConfig(
  value: unknown
): ReferralRewardConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_REFERRAL_REWARD_CONFIG;
  }
  const candidate = value as Record<string, unknown>;
  return {
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : DEFAULT_REFERRAL_REWARD_CONFIG.enabled,
    inviter: normalizeSide(
      candidate.inviter,
      DEFAULT_REFERRAL_REWARD_CONFIG.inviter
    ),
    invitee: normalizeSide(
      candidate.invitee,
      DEFAULT_REFERRAL_REWARD_CONFIG.invitee
    ),
  };
}

/**
 * 根据首充积分快照计算一方奖励。
 *
 * @returns 保留两位小数且不超过 1,000,000 的积分数量；无效首充返回 0。
 */
export function calculateReferralReward(
  side: ReferralRewardSide,
  firstPaymentCredits: number
) {
  if (!Number.isFinite(firstPaymentCredits) || firstPaymentCredits <= 0) {
    return 0;
  }
  const raw =
    side.mode === "fixed"
      ? side.value
      : (firstPaymentCredits * side.value) / 100;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(
    Math.floor((raw + Number.EPSILON) * 100) / 100,
    REFERRAL_REWARD_FIXED_MAX
  );
}
