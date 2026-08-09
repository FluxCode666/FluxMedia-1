/**
 * 推广归因与首充奖励服务。
 *
 * 使用方：Better Auth 用户创建钩子、支付履约服务、用户推广页和 UOL bindings。
 * 关键依赖：referral_profile/referral_relationship、payment_order 归属与 credits ledger。
 * WHY：关系创建和奖励发放都通过数据库唯一约束与稳定 sourceRef 幂等，适配多实例、
 * webhook 重放和奖励中途失败后的恢复。
 */
import crypto from "node:crypto";

import {
  db,
  referralProfile,
  referralRelationship,
  user,
} from "@repo/database";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { grantCredits } from "../credits/core";
import { getRuntimeSettingJson } from "../system-settings";
import {
  calculateReferralReward,
  normalizeReferralRewardConfig,
  REFERRAL_REWARD_CONFIG_SETTING_KEY,
  type ReferralRewardConfig,
} from "./config";
import {
  normalizeReferralCode,
  type ReferralRelationshipStatus,
} from "./contract";
import { REFERRAL_CODE_COOKIE } from "./cookie";

const REFERRAL_CODE_LENGTH = 10;

/** 从原始 Cookie 请求头读取单个值；解析失败时返回空值。 */
function readCookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  const item = cookieHeader.split(";").find((part) => {
    const [key] = part.trim().split("=");
    return key === name;
  });
  if (!item) return null;
  const [, ...value] = item.trim().split("=");
  try {
    return decodeURIComponent(value.join("="));
  } catch {
    return null;
  }
}

/** 从 Better Auth 创建请求中提取显式字段或推广 cookie。 */
export function readReferralCodeFromAuthContext(
  context:
    | {
        body?: unknown;
        request?: Request | undefined;
      }
    | null
    | undefined
) {
  const body =
    context?.body && typeof context.body === "object"
      ? (context.body as Record<string, unknown>)
      : null;
  const explicit = normalizeReferralCode(body?.referralCode);
  if (explicit) return explicit;
  return normalizeReferralCode(
    readCookieValue(
      context?.request?.headers.get("cookie") ?? null,
      REFERRAL_CODE_COOKIE
    )
  );
}

/** 生成不含特殊字符的公开推广码。 */
function createReferralCode() {
  return crypto
    .randomBytes(8)
    .toString("base64url")
    .replace(/-/g, "A")
    .replace(/_/g, "B")
    .slice(0, REFERRAL_CODE_LENGTH)
    .toUpperCase();
}

/** 确保用户拥有推广码；并发创建由 code 唯一索引和短重试兜底。 */
export async function ensureReferralProfile(userId: string) {
  const [existing] = await db
    .select()
    .from(referralProfile)
    .where(eq(referralProfile.userId, userId))
    .limit(1);
  if (existing) return existing;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [created] = await db
      .insert(referralProfile)
      .values({ userId, code: createReferralCode() })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [retrieved] = await db
      .select()
      .from(referralProfile)
      .where(eq(referralProfile.userId, userId))
      .limit(1);
    if (retrieved) return retrieved;
  }
  throw new Error("无法创建推广码");
}

/** 以唯一 invitee 约束归因一次推广关系；无效码或自邀请会安全忽略。 */
export async function createReferralRelationshipFromCode(
  inviteeUserId: string,
  rawCode: unknown
) {
  const code = normalizeReferralCode(rawCode);
  if (!code) return { linked: false, reason: "invalid_code" as const };
  const [profile] = await db
    .select({ userId: referralProfile.userId, code: referralProfile.code })
    .from(referralProfile)
    .where(eq(referralProfile.code, code))
    .limit(1);
  if (!profile || profile.userId === inviteeUserId) {
    return { linked: false, reason: "invalid_or_self" as const };
  }
  const [created] = await db
    .insert(referralRelationship)
    .values({
      id: crypto.randomUUID(),
      inviterUserId: profile.userId,
      inviteeUserId,
      referralCode: profile.code,
      rewardConfigSnapshot: {},
    })
    .onConflictDoNothing({ target: referralRelationship.inviteeUserId })
    .returning({ id: referralRelationship.id });
  return created
    ? { linked: true, relationshipId: created.id }
    : { linked: false, reason: "already_linked" as const };
}

export type ReferralDashboard = {
  code: string;
  inviteUrl: string;
  invitedCount: number;
  rewardedCount: number;
  totalRewardCredits: number;
  rewardConfig: ReferralRewardConfig;
  relationships: Array<{
    id: string;
    inviteeName: string;
    inviteeEmail: string;
    status: ReferralRelationshipStatus;
    inviterRewardCredits: number;
    inviteeRewardCredits: number;
    createdAt: string;
    rewardedAt: string | null;
  }>;
};

/** 读取当前用户推广码、当前奖励配置与有界关系列表，邮箱只返回脱敏地址。 */
export async function getReferralDashboard(input: {
  userId: string;
  appUrl: string;
}) {
  const profile = await ensureReferralProfile(input.userId);
  const [[summary], rows, rewardConfig] = await Promise.all([
    db
      .select({
        invitedCount: sql<number>`count(*)`.mapWith(Number),
        rewardedCount:
          sql<number>`count(*) filter (where ${referralRelationship.status} = 'rewarded')`.mapWith(
            Number
          ),
        totalRewardCredits:
          sql<number>`coalesce(sum(${referralRelationship.inviterRewardCredits}), 0)`.mapWith(
            Number
          ),
      })
      .from(referralRelationship)
      .where(eq(referralRelationship.inviterUserId, input.userId)),
    db
      .select({
        id: referralRelationship.id,
        inviteeName: user.name,
        inviteeEmail: user.email,
        status: referralRelationship.status,
        inviterRewardCredits: referralRelationship.inviterRewardCredits,
        inviteeRewardCredits: referralRelationship.inviteeRewardCredits,
        createdAt: referralRelationship.createdAt,
        rewardedAt: referralRelationship.rewardedAt,
      })
      .from(referralRelationship)
      .innerJoin(user, eq(user.id, referralRelationship.inviteeUserId))
      .where(eq(referralRelationship.inviterUserId, input.userId))
      .orderBy(desc(referralRelationship.createdAt))
      .limit(100),
    loadReferralConfig(),
  ]);
  const relationships = rows.map((row) => ({
    ...row,
    inviteeEmail: maskEmail(row.inviteeEmail),
    inviterRewardCredits: Number(row.inviterRewardCredits),
    inviteeRewardCredits: Number(row.inviteeRewardCredits),
    createdAt: row.createdAt.toISOString(),
    rewardedAt: row.rewardedAt?.toISOString() ?? null,
  }));
  return {
    code: profile.code,
    inviteUrl: `${input.appUrl.replace(/\/$/, "")}/r/${profile.code}`,
    invitedCount: Number(summary?.invitedCount ?? 0),
    rewardedCount: Number(summary?.rewardedCount ?? 0),
    totalRewardCredits: Number(summary?.totalRewardCredits ?? 0),
    rewardConfig,
    relationships,
  } satisfies ReferralDashboard;
}

/** 脱敏推广关系中的邮箱，只保留首字符和域名用于识别。 */
function maskEmail(email: string) {
  const [local, domain] = email.split("@", 2);
  if (!local || !domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

async function loadReferralConfig(): Promise<ReferralRewardConfig> {
  return normalizeReferralRewardConfig(
    await getRuntimeSettingJson(REFERRAL_REWARD_CONFIG_SETTING_KEY)
  );
}

/** 读取新人推广关系；所有履约重试都通过同一窄查询重新确认状态。 */
async function findReferralRelationship(
  input:
    | {
        inviteeUserId: string;
        id?: never;
      }
    | {
        id: string;
        inviteeUserId?: never;
      }
) {
  const predicate =
    input.id !== undefined
      ? eq(referralRelationship.id, input.id)
      : eq(referralRelationship.inviteeUserId, input.inviteeUserId);
  return db
    .select({
      id: referralRelationship.id,
      inviterUserId: referralRelationship.inviterUserId,
      inviteeUserId: referralRelationship.inviteeUserId,
      firstPaymentOrderId: referralRelationship.firstPaymentOrderId,
      status: referralRelationship.status,
      inviterRewardCredits: referralRelationship.inviterRewardCredits,
      inviteeRewardCredits: referralRelationship.inviteeRewardCredits,
      rewardConfigSnapshot: referralRelationship.rewardConfigSnapshot,
    })
    .from(referralRelationship)
    .where(predicate)
    .limit(1);
}

type ReferralFulfillmentResult =
  | {
      rewarded: true;
      inviterRewardCredits: number;
      inviteeRewardCredits: number;
    }
  | { rewarded: false; reason: "disabled" };

/** 将同一订单已达到的终态映射为履约结果；进行态交给当前调用方接管。 */
function resolveExistingReferralResult(
  relationship: Awaited<ReturnType<typeof findReferralRelationship>>[number],
  orderId: string
): ReferralFulfillmentResult | null {
  if (relationship.firstPaymentOrderId !== orderId) return null;
  if (relationship.status === "skipped") {
    return { rewarded: false, reason: "disabled" };
  }
  if (relationship.status === "rewarded") {
    return {
      rewarded: true,
      inviterRewardCredits: Number(relationship.inviterRewardCredits),
      inviteeRewardCredits: Number(relationship.inviteeRewardCredits),
    };
  }
  return null;
}

/**
 * 为新人首个已验证充值订单发放双方奖励。
 *
 * 首先用 first_payment_order_id IS NULL 抢占资格，然后对两方分别执行幂等 grant；
 * 某一方失败时关系仍保留订单号，下一次同订单重试会补发缺失一方而不会重复发放。
 */
export async function fulfillReferralFirstPayment(input: {
  orderId: string;
  inviteeUserId: string;
  firstPaymentCredits: number;
  paymentProvider: "alipay" | "alipay_f2f" | "epay" | "creem";
}) {
  const [relationship] = await findReferralRelationship({
    inviteeUserId: input.inviteeUserId,
  });
  if (!relationship)
    return { rewarded: false as const, reason: "no_referral" as const };
  if (
    relationship.firstPaymentOrderId &&
    relationship.firstPaymentOrderId !== input.orderId
  ) {
    return { rewarded: false as const, reason: "already_used" as const };
  }

  const existingResult = resolveExistingReferralResult(
    relationship,
    input.orderId
  );
  if (existingResult) return existingResult;

  // 已领取但尚未完成的同一订单必须复用首次保存的配置快照。否则运营调整配置后，
  // 两方可能按不同规则发放，且完成态投影会与真实账本不一致。
  let config = relationship.firstPaymentOrderId
    ? normalizeReferralRewardConfig(relationship.rewardConfigSnapshot)
    : await loadReferralConfig();
  if (!config.enabled) {
    const [skipped] = await db
      .update(referralRelationship)
      .set({
        firstPaymentOrderId: input.orderId,
        status: "skipped",
        rewardConfigSnapshot: config,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(referralRelationship.id, relationship.id),
          isNull(referralRelationship.firstPaymentOrderId)
        )
      )
      .returning({ id: referralRelationship.id });
    if (!skipped) {
      const [current] = await findReferralRelationship({ id: relationship.id });
      const currentResult = current
        ? resolveExistingReferralResult(current, input.orderId)
        : null;
      if (currentResult) return currentResult;
      return { rewarded: false as const, reason: "already_used" as const };
    }
    return { rewarded: false as const, reason: "disabled" as const };
  }

  if (!relationship.firstPaymentOrderId) {
    const [claimed] = await db
      .update(referralRelationship)
      .set({
        firstPaymentOrderId: input.orderId,
        rewardConfigSnapshot: config,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(referralRelationship.id, relationship.id),
          isNull(referralRelationship.firstPaymentOrderId)
        )
      )
      .returning({ id: referralRelationship.id });
    if (!claimed) {
      const [current] = await findReferralRelationship({ id: relationship.id });
      const currentResult = current
        ? resolveExistingReferralResult(current, input.orderId)
        : null;
      if (currentResult) return currentResult;
      if (current?.firstPaymentOrderId === input.orderId) {
        // 另一个实例已经抢占但尚未完成，下面继续使用数据库中的快照接管履约。
        config = normalizeReferralRewardConfig(current.rewardConfigSnapshot);
      }
      if (!current || current.firstPaymentOrderId !== input.orderId) {
        return { rewarded: false as const, reason: "already_used" as const };
      }
      if (!config.enabled) {
        return { rewarded: false as const, reason: "disabled" as const };
      }
    }
  }

  const inviterReward = calculateReferralReward(
    config.inviter,
    input.firstPaymentCredits
  );
  const inviteeReward = calculateReferralReward(
    config.invitee,
    input.firstPaymentCredits
  );
  const rewardBase = `referral:first_payment:${input.orderId}`;

  if (inviterReward > 0) {
    await grantCredits({
      userId: relationship.inviterUserId,
      amount: inviterReward,
      sourceType: "referral",
      transactionType: "referral_reward",
      debitAccount: "SYSTEM:referral_reward",
      sourceRef: `${rewardBase}:inviter`,
      description: "推广首充奖励（邀请人）",
      metadata: {
        role: "inviter",
        orderId: input.orderId,
        provider: input.paymentProvider,
      },
    });
  }
  if (inviteeReward > 0) {
    await grantCredits({
      userId: relationship.inviteeUserId,
      amount: inviteeReward,
      sourceType: "referral",
      transactionType: "referral_reward",
      debitAccount: "SYSTEM:referral_reward",
      sourceRef: `${rewardBase}:invitee`,
      description: "推广首充奖励（新人）",
      metadata: {
        role: "invitee",
        orderId: input.orderId,
        provider: input.paymentProvider,
      },
    });
  }

  await db
    .update(referralRelationship)
    .set({
      status: "rewarded",
      inviterRewardCredits: inviterReward,
      inviteeRewardCredits: inviteeReward,
      rewardedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(referralRelationship.id, relationship.id),
        eq(referralRelationship.firstPaymentOrderId, input.orderId),
        eq(referralRelationship.status, "pending")
      )
    );
  return {
    rewarded: true as const,
    inviterRewardCredits: inviterReward,
    inviteeRewardCredits: inviteeReward,
  };
}
