/**
 * Creem 已验签积分购买通知的领域履约服务。
 *
 * 使用方：credits.fulfillCreemTopUp UOL binding。负责更新 Creem customerId、兼容
 * 历史无本地订单通知、校验冻结订单快照与实付金额，并驱动持久支付工作项。
 */
import { db } from "@repo/database";
import { paymentOrder, user } from "@repo/database/schema";
import { CREDIT_CONFIG_DEFAULTS } from "@repo/shared/credits/config";
import { grantCredits } from "@repo/shared/credits/core";
import {
  getCreditPackageCurrency,
  getRuntimeCreditPackageById,
} from "@repo/shared/credits/packages";
import { getCurrencyMinorUnitExponent } from "@repo/shared/credits/top-up";
import { logError, logEvent, logger } from "@repo/shared/logger";
import {
  evaluateCreemAmountMatch,
  shouldGrantAfterAmountCheck,
} from "@repo/shared/payment/creem-amount";
import { getRuntimeSettingNumber } from "@repo/shared/system-settings";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { processPaymentFulfillmentOrder } from "@/features/payment/payment-fulfillment-service";
import {
  confirmPaymentAndCreateFulfillmentWorkItem,
  rejectCreemPaymentAmountMismatch,
} from "@/features/payment/payment-lifecycle-service";
import { invokeReferralFirstPayment } from "@/features/referrals/reward-fulfillment";

/** UOL 已校验、且不含原始签名或完整 Creem payload 的最小履约通知。 */
export type CreemCreditPurchaseNotification = {
  checkoutId: string;
  requestId?: string;
  customerId: string;
  userId?: string;
  paymentOrderId?: string;
  packageId?: string;
  order?: {
    id: string;
    amount: number;
    currency: string;
    productId?: string;
  };
  product?: { id: string; billingType?: string };
  createdAt: number;
};

const creditPackagePricingSnapshotSchema = z
  .object({
    packageId: z.string().min(1),
    quantity: z.number().int().positive(),
    currency: z.string().min(1),
    amountMinor: z.number().int().positive(),
    creditsAmount: z.number().positive(),
    creditsExpiresAt: z.string().datetime().nullable().optional(),
  })
  .passthrough();

const creemPaymentOrderSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  provider: z.literal("creem"),
  purpose: z.literal("credit_package"),
  currency: z.string().min(1),
  amountMinor: z.coerce.number().int().positive(),
  creditsAmount: z.coerce.number().positive(),
  pricingSnapshot: creditPackagePricingSnapshotSchema,
});

/** 读取 Creem 金额不一致是否应硬拒的部署开关。 */
function isCreemAmountEnforced(): boolean {
  const raw = process.env.CREEM_WEBHOOK_ENFORCE_AMOUNT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * 对实付金额判断增加低敏日志，并返回是否继续履约。
 *
 * 不可比较或软门闩不一致时保留历史发放语义并告警；硬门闩拒绝时记录错误，调用方
 * 必须原子终结本地订单，不能创建积分履约工作项。
 */
function shouldGrantWithLogging(
  amountMatch: ReturnType<typeof evaluateCreemAmountMatch>,
  context: Record<string, unknown>
): boolean {
  const decision = shouldGrantAfterAmountCheck(
    amountMatch,
    isCreemAmountEnforced()
  );

  if (
    decision.grant &&
    decision.reason === "not-comparable-grant-with-warning"
  ) {
    logger.warn(
      { ...context, source: "creem-webhook", amountMatch, decision },
      "Creem amount check skipped (not comparable); granting credits"
    );
  } else if (
    decision.grant &&
    decision.reason === "mismatch-soft-gate-grant-with-warning"
  ) {
    logger.warn(
      { ...context, source: "creem-webhook", amountMatch, decision },
      "Creem amount mismatch detected (soft gate, not enforced); granting credits"
    );
  } else if (!decision.grant) {
    logError(new Error("Creem paid amount/currency mismatch"), {
      source: "creem-webhook",
      stage: "amount-check",
      amountMatch,
      decision,
      ...context,
    });
  }

  return decision.grant;
}

/** 按当前运营配置计算历史积分包到期时间；零天表示永久有效。 */
async function getLegacyCreditPackExpiresAt(): Promise<Date | null> {
  const expiryDays = await getRuntimeSettingNumber(
    "CREDITS_EXPIRY_DAYS",
    CREDIT_CONFIG_DEFAULTS.creditsExpiryDays,
    { nonNegative: true }
  );
  return expiryDays > 0
    ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
    : null;
}

/** 将已验签事件时间转换为落库时间，无效值才降级为服务接收时间。 */
function getCreemOccurredAt(createdAt: number): {
  occurredAt: Date;
  timestampSource: "provider" | "server_received";
} {
  const occurredAt = new Date(createdAt);
  if (!Number.isNaN(occurredAt.getTime())) {
    return { occurredAt, timestampSource: "provider" };
  }
  return { occurredAt: new Date(), timestampSource: "server_received" };
}

/**
 * 兼容升级前没有本地 payment_order 的 Creem 积分购买。
 *
 * 套餐和到期时间按当前服务端配置读取，但保留历史
 * `credit_purchase:<creemOrderId>` 幂等键；缺少或未知套餐时记录错误并忽略通知。
 */
async function fulfillLegacyCreditPurchase(
  userId: string,
  notification: CreemCreditPurchaseNotification,
  creemOrderId: string
): Promise<void> {
  const packageId = notification.packageId;
  if (!packageId) {
    logger.error(
      { source: "creem-webhook", userId, creemOrderId },
      "Missing packageId in legacy credit_purchase metadata"
    );
    return;
  }

  const creditPackage = await getRuntimeCreditPackageById(packageId, {
    includeHidden: true,
  });
  if (!creditPackage) {
    logger.error(
      { source: "creem-webhook", packageId, userId },
      "Unknown legacy credit package ID"
    );
    return;
  }

  const quantity = 1;
  const creditsAmount = creditPackage.credits * quantity;
  const unitPrice = creditPackage.price;
  const amountMatch = evaluateCreemAmountMatch(
    {
      amount: unitPrice * quantity,
      currency: getCreditPackageCurrency(creditPackage),
    },
    {
      amount: notification.order?.amount ?? Number.NaN,
      currency: notification.order?.currency ?? "",
    }
  );
  if (
    !shouldGrantWithLogging(amountMatch, {
      stage: "legacy-credit-purchase",
      userId,
      packageId,
      orderId: creemOrderId,
    })
  ) {
    return;
  }

  const result = await grantCredits({
    userId,
    amount: creditsAmount,
    sourceType: "purchase",
    debitAccount: `PAYMENT:${creemOrderId}`,
    transactionType: "purchase",
    expiresAt: await getLegacyCreditPackExpiresAt(),
    sourceRef: `credit_purchase:${creemOrderId}`,
    description: `Credit pack purchase: ${creditsAmount} credits (${packageId})`,
    metadata: {
      provider: "creem",
      orderId: creemOrderId,
      packageId,
      checkoutId: notification.checkoutId,
      paymentType: "one-time",
      quantity,
      unitCredits: creditPackage.credits,
      unitPrice,
      paidMoney: unitPrice * quantity,
    },
  });

  logger.info(
    { userId, creditsAmount, packageId, quantity, batchId: result.batchId },
    "Credits granted for legacy credit pack purchase"
  );
  await invokeReferralFirstPayment({
    orderId: creemOrderId,
    inviteeUserId: userId,
    firstPaymentCredits: creditsAmount,
    provider: "creem",
  });
}

/**
 * 校验本地冻结订单并确认 Creem 支付。
 *
 * 新订单以 payment_order、支付生命周期事件、工作项和积分批次约束收敛重放；历史
 * 通知退回兼容路径。金额硬拒时只终结订单，不创建履约工作项。
 */
async function fulfillCreditPurchase(
  userId: string,
  notification: CreemCreditPurchaseNotification,
  eventTime: ReturnType<typeof getCreemOccurredAt>
): Promise<void> {
  const reportedPackageId = notification.packageId;
  const creemOrderId = notification.order?.id ?? notification.checkoutId;
  const paymentOrderId = notification.paymentOrderId;
  if (!paymentOrderId) {
    await fulfillLegacyCreditPurchase(userId, notification, creemOrderId);
    return;
  }

  const [rawOrder] = await db
    .select({
      id: paymentOrder.id,
      userId: paymentOrder.userId,
      provider: paymentOrder.provider,
      purpose: paymentOrder.purpose,
      currency: paymentOrder.currency,
      amountMinor: paymentOrder.amountMinor,
      creditsAmount: paymentOrder.creditsAmount,
      pricingSnapshot: paymentOrder.pricingSnapshot,
    })
    .from(paymentOrder)
    .where(eq(paymentOrder.id, paymentOrderId))
    .limit(1);
  const order = creemPaymentOrderSchema.parse(rawOrder);
  if (order.userId !== userId) {
    throw new Error("Creem 通知用户与本地订单不匹配");
  }
  const snapshot = order.pricingSnapshot;
  if (
    snapshot.currency !== order.currency ||
    snapshot.amountMinor !== order.amountMinor ||
    snapshot.creditsAmount !== order.creditsAmount
  ) {
    throw new Error("Creem 支付订单冻结快照不一致");
  }

  const currencyScale = 10 ** getCurrencyMinorUnitExponent(order.currency);
  const amountMatch = evaluateCreemAmountMatch(
    {
      amount: order.amountMinor / currencyScale,
      currency: order.currency,
    },
    {
      amount: notification.order?.amount ?? Number.NaN,
      currency: notification.order?.currency ?? "",
    }
  );
  if (
    !shouldGrantWithLogging(amountMatch, {
      stage: "credit-purchase",
      userId,
      packageId: snapshot.packageId,
      reportedPackageId,
      orderId: creemOrderId,
    })
  ) {
    const rejected = await rejectCreemPaymentAmountMismatch({
      orderId: paymentOrderId,
      userId,
      providerTradeNo: creemOrderId,
      eventSourceRef: `creem:${creemOrderId}`,
      occurredAt: eventTime.occurredAt,
    });
    if (!rejected) {
      throw new Error("Creem 异常金额订单状态或交易号已变化");
    }
    return;
  }

  const confirmation = await confirmPaymentAndCreateFulfillmentWorkItem({
    orderId: paymentOrderId,
    userId,
    provider: "creem",
    providerTradeNo: creemOrderId,
    eventSourceRef: `creem:${creemOrderId}`,
    occurredAt: eventTime.occurredAt,
    timestampSource: eventTime.timestampSource,
    fulfillment: {
      creditsAmount: order.creditsAmount,
      creditSourceRef: `creem:${paymentOrderId}`,
      debitAccount: `PAYMENT:${creemOrderId}`,
      description: `Credit pack purchase: ${order.creditsAmount} credits (${snapshot.packageId})`,
      metadata: {
        provider: "creem",
        orderId: creemOrderId,
        paymentOrderId,
        packageId: snapshot.packageId,
        reportedPackageId,
        checkoutId: notification.checkoutId,
        paymentType: "one-time",
        creditsAmount: order.creditsAmount,
        quantity: snapshot.quantity,
        amountMinor: order.amountMinor,
        currency: order.currency,
        paidMoneyMinor: notification.order?.amount,
      },
    },
  });
  if (confirmation !== "fulfilled") {
    await processPaymentFulfillmentOrder(paymentOrderId);
  }
}

/**
 * 履约一条已验签且类型为 credit_purchase 的 Creem Checkout 通知。
 *
 * 缺少 userId 时保持历史 2xx 忽略语义；其余校验或持久化失败显式上抛，让 webhook
 * 路由返回 5xx 触发 Creem 重投。
 */
export async function fulfillSuccessfulCreemPayment(
  notification: CreemCreditPurchaseNotification
): Promise<void> {
  const userId = notification.userId;
  if (!userId) {
    logger.error(
      { source: "creem-webhook" },
      "Missing userId in checkout metadata"
    );
    return;
  }

  await db
    .update(user)
    .set({ customerId: notification.customerId })
    .where(eq(user.id, userId));

  await fulfillCreditPurchase(
    userId,
    notification,
    getCreemOccurredAt(notification.createdAt)
  );

  logEvent("payment.checkout.completed", {
    userId,
    customerId: notification.customerId,
    productId: notification.product?.id ?? notification.order?.productId,
    billingType: notification.product?.billingType,
    checkoutType: "credit_purchase",
  });
}
