/**
 * Creem webhook 薄适配器。
 *
 * 使用方：Creem 已验签 Checkout 通知。新版积分包履约只读取 payment_order 冻结快照；
 * 升级前没有本地订单 ID 的历史通知按服务端套餐配置兼容履约。
 */
import { db } from "@repo/database";
import { paymentOrder, user } from "@repo/database/schema";
import { withApiLogging } from "@repo/shared/api-logger";
import { CREDIT_CONFIG_DEFAULTS } from "@repo/shared/credits/config";
import { grantCredits } from "@repo/shared/credits/core";
import {
  getCreditPackageCurrency,
  getRuntimeCreditPackageById,
} from "@repo/shared/credits/packages";
import { getCurrencyMinorUnitExponent } from "@repo/shared/credits/top-up";
import { logError, logEvent, logger } from "@repo/shared/logger";
import {
  type CreemCheckoutCompletedData,
  type CreemWebhookEvent,
  constructRuntimeCreemEvent,
} from "@repo/shared/payment/creem";
import {
  evaluateCreemAmountMatch,
  shouldGrantAfterAmountCheck,
} from "@repo/shared/payment/creem-amount";
import { getRuntimeSettingNumber } from "@repo/shared/system-settings";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { processPaymentFulfillmentOrder } from "@/features/payment/payment-fulfillment-service";
import {
  confirmPaymentAndCreateFulfillmentWorkItem,
  rejectCreemPaymentAmountMismatch,
} from "@/features/payment/payment-lifecycle-service";
import { invokeReferralFirstPayment } from "@/features/referrals/reward-fulfillment";

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

// ============================================
// 实付金额/币种反欺诈校验（软门闩）
// 纯逻辑已抽离至 @repo/shared/payment/creem-amount，此处仅保留环境读取与日志适配。
// ============================================

/**
 * 是否对金额/币种不符的支付硬拒（不发放积分）。
 *
 * WHY 读 env 而非 system-settings：system-settings 的 SettingKey 是受约束联合类型，
 * 新增键需改 definitions.ts（本单元不允许触碰），故此处以 env 软开关落地，默认关闭。
 */
function isCreemAmountEnforced(): boolean {
  const raw = process.env.CREEM_WEBHOOK_ENFORCE_AMOUNT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * 对 Creem 金额校验结果落地处置（带日志）：返回 true=继续发放，false=拒绝发放。
 *
 * 封装 @repo/shared/payment/creem-amount 的纯函数 shouldGrantAfterAmountCheck，
 * 在此处追加 Pino 日志输出（纯函数模块不依赖 logger）。
 */
function shouldGrantWithLogging(
  amountMatch: import("@repo/shared/payment/creem-amount").CreemAmountMatchResult,
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

/** 按当前运营配置计算历史积分包的到期时间；零天表示永久有效。 */
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

/** 将已验签 Creem 事件时间转换为可落库时间，无效值才降级到接收时间。 */
function getCreemOccurredAt(createdAt: number) {
  const occurredAt = new Date(createdAt);
  if (!Number.isNaN(occurredAt.getTime())) {
    return { occurredAt, timestampSource: "provider" as const };
  }
  return {
    occurredAt: new Date(),
    timestampSource: "server_received" as const,
  };
}

/**
 * Creem Webhook 处理器
 *
 * 处理来自 Creem 的事件通知
 * 文档: https://docs.creem.io/code/webhooks
 */
export const POST = withApiLogging(async (req: Request) => {
  const body = await req.text();
  const headersList = await headers();
  const signature = headersList.get("creem-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing creem-signature header" },
      { status: 400 }
    );
  }

  let event: CreemWebhookEvent;

  try {
    // 验证 Webhook 签名并解析事件
    event = await constructRuntimeCreemEvent(body, signature);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    logError(err, { source: "creem-webhook", stage: "signature" });
    return NextResponse.json(
      { error: `Webhook Error: ${errorMessage}` },
      { status: 400 }
    );
  }

  try {
    // 处理不同类型的事件
    switch (event.eventType) {
      // ============================================
      // Checkout 完成事件
      // ============================================
      case "checkout.completed": {
        const data = event.object as CreemCheckoutCompletedData;
        if (data.metadata?.type !== "credit_purchase") {
          logIgnoredCreemEvent(event, data.request_id);
          break;
        }
        await handleCheckoutCompleted(
          data,
          getCreemOccurredAt(event.created_at)
        );
        break;
      }

      // ============================================
      // 订阅相关事件
      // ============================================
      case "subscription.active":
      case "subscription.renewed":
      case "subscription.paid":
      case "subscription.canceled":
      case "subscription.past_due":
      case "subscription.paused":
      case "subscription.expired": {
        logIgnoredCreemEvent(event);
        break;
      }

      default:
        logger.info({ eventType: event.eventType }, "Unhandled event type");
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    logError(error, { source: "creem-webhook", stage: "handler" });
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
});

/**
 * 记录已验签但已退役的订阅事件。
 *
 * 只保留 provider、事件类型、截断后的事件/请求 ID，避免原始 payload、签名和
 * 用户信息进入日志；调用方必须在任何数据库操作之前调用此函数。
 */
function logIgnoredCreemEvent(event: CreemWebhookEvent, requestId?: string) {
  const eventId = event.id.slice(0, 128);
  const sanitizedRequestId = requestId?.slice(0, 128);
  logger.info(
    {
      provider: "creem",
      eventType: event.eventType,
      eventId,
      ...(sanitizedRequestId ? { requestId: sanitizedRequestId } : {}),
    },
    "Ignored retired subscription webhook"
  );
}

// ============================================
// Checkout 完成处理
// ============================================

/**
 * 兼容升级前没有本地支付订单 ID 的 Creem 积分包通知。
 *
 * @param userId 已验签 metadata 中的购买用户。
 * @param data 已验签的 Checkout 完成数据。
 * @param creemOrderId Creem 订单 ID；同时作为积分与首充奖励的稳定幂等身份。
 * @returns 无返回值；缺少或找不到服务端套餐时记录错误并停止履约。
 * @sideeffect 按当前服务端套餐发放积分，并调用 Creem 首充奖励 operation。
 * @failure 发放或首充履约失败时上抛，由外层返回 5xx 触发 Creem 重投。
 *
 * WHY：旧 Checkout 没有 payment_order，无法使用冻结快照工作项。这里保留旧
 * `credit_purchase:${creemOrderId}` 幂等键，并直接依赖 grantCredits 的数据库唯一
 * 约束收敛并发与重放；首充 operation 同样复用 Creem 订单 ID 保持历史语义。
 */
async function handleLegacyCreditPurchase(
  userId: string,
  data: CreemCheckoutCompletedData,
  creemOrderId: string
) {
  const packageId = data.metadata?.packageId;
  if (!packageId) {
    logger.error(
      { source: "creem-webhook", userId, creemOrderId },
      "Missing packageId in legacy credit_purchase metadata"
    );
    return;
  }

  const pkg = await getRuntimeCreditPackageById(packageId, {
    includeHidden: true,
  });
  if (!pkg) {
    logger.error(
      { source: "creem-webhook", packageId, userId },
      "Unknown legacy credit package ID"
    );
    return;
  }

  const quantity = 1;
  const creditsAmount = pkg.credits * quantity;
  const unitPrice = pkg.price;
  const amountMatch = evaluateCreemAmountMatch(
    {
      amount: unitPrice * quantity,
      currency: getCreditPackageCurrency(pkg),
    },
    {
      amount: data.order?.amount ?? Number.NaN,
      currency: data.order?.currency ?? "",
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

  const sourceRef = `credit_purchase:${creemOrderId}`;
  const result = await grantCredits({
    userId,
    amount: creditsAmount,
    sourceType: "purchase",
    debitAccount: `PAYMENT:${creemOrderId}`,
    transactionType: "purchase",
    expiresAt: await getLegacyCreditPackExpiresAt(),
    sourceRef,
    description: `Credit pack purchase: ${creditsAmount} credits (${packageId})`,
    metadata: {
      provider: "creem",
      orderId: creemOrderId,
      packageId,
      checkoutId: data.id,
      paymentType: "one-time",
      quantity,
      unitCredits: pkg.credits,
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
 * 处理 Checkout 完成事件
 *
 * 当用户完成一次性积分购买后发放积分。
 */
async function handleCheckoutCompleted(
  data: CreemCheckoutCompletedData,
  eventTime: ReturnType<typeof getCreemOccurredAt>
) {
  const userId = data.metadata?.userId;
  const customerId = data.customer.id;
  const productId = data.product?.id || data.order?.product;
  const checkoutType = data.metadata?.type;

  if (!userId) {
    logger.error(
      { source: "creem-webhook" },
      "Missing userId in checkout metadata"
    );
    return;
  }

  // 更新用户的 customerId
  await db.update(user).set({ customerId }).where(eq(user.id, userId));

  // 根据 checkout 类型分别处理
  if (checkoutType === "credit_purchase") {
    // 积分包一次性购买
    await handleCreditPurchase(userId, data, eventTime);
  }

  logEvent("payment.checkout.completed", {
    userId,
    customerId,
    productId,
    billingType: data.product?.billing_type,
    checkoutType,
  });
}

/**
 * 处理积分包购买
 *
 * 在一次性支付完成后，根据订单创建时冻结的快照发放积分。
 *
 * @param userId webhook metadata 声明的用户，只用于与本地订单归属交叉校验。
 * @param data 已验签且通过运行时结构校验的 Checkout 完成数据。
 * @returns 无返回值；首次或重放确认会触发持久履约 worker。
 * @sideeffect 新订单创建支付确认和工作项；历史订单直接执行兼容履约。
 * @failure 本地订单归属不匹配、冻结快照不一致或履约失败时 fail closed。
 */
async function handleCreditPurchase(
  userId: string,
  data: CreemCheckoutCompletedData,
  eventTime: ReturnType<typeof getCreemOccurredAt>
) {
  const reportedPackageId = data.metadata?.packageId;
  const creemOrderId = data.order?.id ?? data.id;
  const paymentOrderId = data.metadata?.paymentOrderId;
  if (!paymentOrderId) {
    await handleLegacyCreditPurchase(userId, data, creemOrderId);
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

  // 实付校验使用订单创建时冻结的最小货币单位与币种。管理员随后调整积分包价格、
  // 币种或积分数量不会改变旧订单；metadata.packageId 仅保留为通知关联审计字段。
  const currencyScale = 10 ** getCurrencyMinorUnitExponent(order.currency);
  const amountMatch = evaluateCreemAmountMatch(
    {
      amount: order.amountMinor / currencyScale,
      currency: order.currency,
    },
    {
      amount: data.order?.amount ?? Number.NaN,
      currency: data.order?.currency ?? "",
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
        checkoutId: data.id,
        paymentType: "one-time",
        creditsAmount: order.creditsAmount,
        quantity: snapshot.quantity,
        amountMinor: order.amountMinor,
        currency: order.currency,
        paidMoneyMinor: data.order?.amount,
      },
    },
  });
  if (confirmation !== "fulfilled") {
    await processPaymentFulfillmentOrder(paymentOrderId);
  }
}
