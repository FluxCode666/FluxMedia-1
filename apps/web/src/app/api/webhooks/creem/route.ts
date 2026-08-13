/**
 * Creem webhook 薄适配器。
 *
 * 使用方：Creem 已验签 Checkout 通知。积分包履约只读取本地 payment_order 冻结快照，
 * 运行时积分包配置和客户端 metadata 均不参与金额、币种或积分数量裁决。
 */
import { db } from "@repo/database";
import { paymentOrder, user } from "@repo/database/schema";
import { withApiLogging } from "@repo/shared/api-logger";
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
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { processPaymentFulfillmentOrder } from "@/features/payment/payment-fulfillment-service";
import {
  confirmPaymentAndCreateFulfillmentWorkItem,
  rejectCreemPaymentAmountMismatch,
} from "@/features/payment/payment-lifecycle-service";

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
 * @sideeffect 读取本地订单，创建支付确认和工作项，必要时触发积分履约。
 * @failure 缺订单、归属不匹配或冻结快照内部不一致时 fail closed。
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
    throw new Error("Creem 积分包通知缺少本地支付订单 ID");
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
