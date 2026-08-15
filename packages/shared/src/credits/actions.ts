"use server";

/**
 * 积分系统 Server Actions
 *
 * 提供积分系统的前端调用接口
 */

import { db } from "@repo/database";
import { creditsTransaction, externalApiKey } from "@repo/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { normalizeUserRole } from "../auth/roles";
import { logEvent } from "../logger/index";
import { getRuntimePaymentProvider } from "../payment/epay";
import { ActionUserError, protectedAction } from "../safe-action";
import { getRuntimeSettingNumber } from "../system-settings";
import { invokeOperation, OperationError } from "../uol";
import {
  createPurchaseCheckout,
  createPurchaseCheckoutInputSchema,
} from "../uol/operations/credits";

import { CREDIT_CONFIG_DEFAULTS, isCreditPackageVisible } from "./config";
import {
  AccountFrozenError,
  consumeCredits,
  ensureRegistrationBonus,
  ensureRegistrationBonusExpiry,
  getCreditsBalance,
  getUserActiveBatches,
  getUserTransactions,
  getUserTransactionsCount,
  grantCredits,
  InsufficientCreditsError,
} from "./core";
import {
  getCreditPackageCurrency,
  getCreditPackagePrice,
  getRuntimeCreditPackages,
} from "./packages";
import type { CreditPackagePurchaseCheckoutOutput } from "./purchase-checkout-service";

const withProtectedCreditsAction = (name: string) =>
  protectedAction.metadata({ action: `credits.${name}` });

async function getRuntimeRegistrationBonusCredits() {
  return getRuntimeSettingNumber(
    "REGISTRATION_BONUS_CREDITS",
    CREDIT_CONFIG_DEFAULTS.registrationBonusCredits,
    { positive: true }
  );
}

async function getRuntimeFreeCreditsExpiryDays() {
  return getRuntimeSettingNumber(
    "FREE_CREDITS_EXPIRY_DAYS",
    CREDIT_CONFIG_DEFAULTS.freeCreditsExpiryDays,
    { positive: true }
  );
}

function getExpiryDate(expiryDays: number) {
  return expiryDays
    ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
    : null;
}

// ============================================
// 受保护 Actions（需要登录）
// ============================================

/**
 * 注册奖励积分
 *
 * 需要登录，且每个用户只能领取一次
 */
export const grantRegistrationBonus = withProtectedCreditsAction(
  "grantRegistrationBonus"
)
  .schema(z.object({}))
  .action(async ({ ctx }) => {
    const { userId } = ctx;

    // 幂等性检查：查询是否已发放过注册奖励
    const existing = await db
      .select({ id: creditsTransaction.id })
      .from(creditsTransaction)
      .where(
        and(
          eq(creditsTransaction.userId, userId),
          eq(creditsTransaction.type, "registration_bonus")
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await ensureRegistrationBonusExpiry(userId);
      return { success: true, alreadyGranted: true };
    }

    const bonusCredits = await getRuntimeRegistrationBonusCredits();
    const freeExpiryDays = await getRuntimeFreeCreditsExpiryDays();

    const result = await grantCredits({
      userId,
      amount: bonusCredits,
      sourceType: "bonus",
      debitAccount: "SYSTEM:registration_bonus",
      transactionType: "registration_bonus",
      expiresAt: getExpiryDate(freeExpiryDays),
      sourceRef: `registration_bonus:${userId}`,
      description: "新用户注册奖励",
      metadata: {
        bonusType: "registration",
      },
    });

    return {
      success: true,
      ...result,
    };
  });

/**
 * 获取当前用户积分余额
 *
 * 包含懒加载注册奖励机制:
 * 首次调用时，如果用户没有领过注册奖励，会自动发放注册奖励
 */
export const getMyCreditsBalance = withProtectedCreditsAction(
  "getMyCreditsBalance"
).action(async ({ ctx }) => {
  const { userId } = ctx;

  // 懒加载: 确保新用户获得注册奖励
  await ensureRegistrationBonus(
    userId,
    await getRuntimeRegistrationBonusCredits()
  );

  // 获取余额
  const balance = await getCreditsBalance(userId);

  return {
    balance: balance.balance,
    totalEarned: balance.totalEarned,
    totalSpent: balance.totalSpent,
    status: balance.status,
  };
});

/**
 * 获取当前用户活跃批次
 */
export const getMyActiveBatches = withProtectedCreditsAction(
  "getMyActiveBatches"
).action(async ({ ctx }) => {
  const { userId } = ctx;
  const batches = await getUserActiveBatches(userId);

  return batches.map((batch) => ({
    id: batch.id,
    amount: batch.amount,
    remaining: batch.remaining,
    issuedAt: batch.issuedAt,
    expiresAt: batch.expiresAt,
    sourceType: batch.sourceType,
  }));
});

/**
 * 获取当前用户交易历史
 */
export const getMyTransactions = withProtectedCreditsAction("getMyTransactions")
  .schema(
    z
      .object({
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      })
      .optional()
  )
  .action(async ({ parsedInput, ctx }) => {
    const { userId } = ctx;
    const limit = parsedInput?.limit;
    const offset = parsedInput?.offset;

    const [transactions, totalCount] = await Promise.all([
      getUserTransactions(userId, {
        ...(limit !== undefined && { limit }),
        ...(offset !== undefined && { offset }),
      }),
      getUserTransactionsCount(userId),
    ]);

    // 解析每条交易是哪个外部 API Key 消耗的(issue #26):从 metadata.externalApiKeyId 收集后批量查
    // external_api_key(限定本人,防越权读他人 key),映射成"名称 (••后四位)"。历史无此字段的记录不显示。
    const apiKeyIds = Array.from(
      new Set(
        transactions
          .map((tx) => {
            const id = (tx.metadata as Record<string, unknown> | null)
              ?.externalApiKeyId;
            return typeof id === "string" ? id : null;
          })
          .filter((id): id is string => Boolean(id))
      )
    );
    const apiKeyNameById = new Map<string, string>();
    if (apiKeyIds.length > 0) {
      const keys = await db
        .select({
          id: externalApiKey.id,
          name: externalApiKey.name,
          lastFour: externalApiKey.lastFour,
        })
        .from(externalApiKey)
        .where(
          and(
            eq(externalApiKey.userId, userId),
            inArray(externalApiKey.id, apiKeyIds)
          )
        );
      for (const key of keys) {
        apiKeyNameById.set(key.id, `${key.name} (••${key.lastFour})`);
      }
    }

    return {
      transactions: transactions.map((tx) => {
        const metadata = tx.metadata as Record<string, unknown> | null;
        const apiKeyId = metadata?.externalApiKeyId;
        const apiKeyName =
          typeof apiKeyId === "string"
            ? (apiKeyNameById.get(apiKeyId) ?? null)
            : null;
        return {
          id: tx.id,
          type: tx.type,
          amount: tx.amount,
          debitAccount: tx.debitAccount,
          creditAccount: tx.creditAccount,
          description: tx.description,
          metadata,
          apiKeyName,
          createdAt: tx.createdAt,
        };
      }),
      totalCount,
    };
  });

/**
 * 消费积分
 *
 * 用于 AI 服务等需要消费积分的场景
 */
export const useCredits = withProtectedCreditsAction("useCredits")
  .schema(
    z.object({
      amount: z.number().positive(),
      serviceName: z.string().min(1),
      description: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const { userId } = ctx;
    const { amount, serviceName, description, metadata } = parsedInput;

    try {
      const result = await consumeCredits({
        userId,
        amount,
        serviceName,
        operationFallback: {
          kind: "ledger_transaction",
          operationType: "manual_consumption",
        },
        ...(description !== undefined && { description }),
        ...(metadata !== undefined && { metadata }),
      });

      logEvent("credits.consumed", {
        userId,
        amount,
        serviceName,
      });

      return {
        success: true,
        consumedAmount: result.consumedAmount,
        remainingBalance: result.remainingBalance,
        transactionId: result.transactionId,
      };
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return {
          success: false,
          error: "insufficient_credits",
          message: error.message,
          required: error.required,
          available: error.available,
        };
      }
      if (error instanceof AccountFrozenError) {
        return {
          success: false,
          error: "account_frozen",
          message: error.message,
        };
      }
      throw error;
    }
  });

/**
 * 检查用户是否有足够积分
 */
export const checkCreditsAvailable = withProtectedCreditsAction(
  "checkCreditsAvailable"
)
  .schema(
    z.object({
      amount: z.number().positive(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const { userId } = ctx;
    const { amount } = parsedInput;

    const balance = await getCreditsBalance(userId);

    // balance 由 ensureCreditsBalance 保证不为 undefined
    return {
      available: balance.balance >= amount && balance.status === "active",
      currentBalance: balance.balance,
      required: amount,
      status: balance.status,
    };
  });

// ============================================
// 积分购买 Checkout
// ============================================

/**
 * 把 UOL 明确标记为可安全展示的积分包购买错误转换为 Action 用户错误。
 *
 * @param error - invokeOperation 抛出的未知错误。
 * @throws ActionUserError 领域服务确认安全的中文提示。
 * @throws unknown 权限、内部错误或第三方异常保持原样，交给安全 Action 隐藏细节。
 */
function throwPurchaseCheckoutActionError(error: unknown): never {
  if (error instanceof OperationError && error.details?.userSafe === true) {
    throw new ActionUserError(error.message);
  }
  throw error;
}

/**
 * 创建积分购买 Checkout Session。
 *
 * 仅把受保护会话转换为 UOL Principal 并调用统一 operation；报价冻结、订单幂等、
 * 第三方外呼和失败回写全部由非 Action 领域服务负责。
 */
export const createCreditsPurchaseCheckout = withProtectedCreditsAction(
  "createCreditsPurchaseCheckout"
)
  .schema(createPurchaseCheckoutInputSchema)
  .action(async ({ parsedInput, ctx }) => {
    try {
      return await invokeOperation<CreditPackagePurchaseCheckoutOutput>(
        createPurchaseCheckout.name,
        parsedInput,
        {
          type: "user",
          userId: ctx.userId,
          role: normalizeUserRole(ctx.user.role),
        }
      );
    } catch (error) {
      throwPurchaseCheckoutActionError(error);
    }
  });

/**
 * 获取积分包列表
 */
export const getCreditPackages = withProtectedCreditsAction(
  "getCreditPackages"
).action(async () => {
  const [packages, paymentProvider] = await Promise.all([
    getRuntimeCreditPackages({
      includeHidden: false,
    }),
    getRuntimePaymentProvider(),
  ]);
  if (paymentProvider === "none" || paymentProvider === "alipay_f2f") {
    return [];
  }
  const useEpay = paymentProvider === "epay";
  return packages
    .filter((pkg) => isCreditPackageVisible(pkg))
    .filter((pkg) => !useEpay || getCreditPackageCurrency(pkg) === "CNY")
    .map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      credits: pkg.credits,
      price: getCreditPackagePrice(pkg),
      currency: getCreditPackageCurrency(pkg),
      description: pkg.description,
      popular: "popular" in pkg ? pkg.popular : false,
      allowQuantity: Boolean(pkg.allowQuantity),
      maxQuantity: pkg.maxQuantity ?? 1,
    }));
});
