import { db } from "@repo/database";
import { creditsBatch, user } from "@repo/database/schema";
import { withApiLogging } from "@repo/shared/api-logger";
import { CREDIT_CONFIG_DEFAULTS } from "@repo/shared/credits/config";
import { grantCredits } from "@repo/shared/credits/core";
import {
  getCreditPackageCurrency,
  getRuntimeCreditPackageById,
} from "@repo/shared/credits/packages";
import {
  claimCreditPackagePaymentOrderForFulfillment,
  failCreditPackagePaymentOrder,
  fulfillCreditPackagePaymentOrder,
  releaseCreditPackagePaymentOrderFulfillment,
} from "@repo/shared/credits/purchase-orders";
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
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

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

async function getCreditPackExpiresAt() {
  const expiryDays = await getRuntimeSettingNumber(
    "CREDITS_EXPIRY_DAYS",
    CREDIT_CONFIG_DEFAULTS.creditsExpiryDays,
    { nonNegative: true }
  );
  return expiryDays > 0
    ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
    : null;
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
        await handleCheckoutCompleted(data);
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
async function handleCheckoutCompleted(data: CreemCheckoutCompletedData) {
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
    await handleCreditPurchase(userId, data);
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
 * 在一次性支付完成后，根据服务端积分包配置发放积分
 * 安全: 不信任 metadata.credits，从服务端积分包配置查找真实积分数量
 */
async function handleCreditPurchase(
  userId: string,
  data: CreemCheckoutCompletedData
) {
  const packageId = data.metadata?.packageId;
  const creemOrderId = data.order?.id ?? data.id;
  const paymentOrderId = data.metadata?.paymentOrderId;
  if (!packageId) {
    logger.error(
      { source: "creem-webhook", userId, creemOrderId },
      "Missing packageId in credit_purchase metadata"
    );
    return;
  }

  // 从服务端配置查找积分数量（不信任客户端 metadata.credits）
  const pkg = await getRuntimeCreditPackageById(packageId, {
    includeHidden: true,
  });
  if (!pkg) {
    logger.error(
      { source: "creem-webhook", packageId, userId },
      "Unknown credit package ID"
    );
    return;
  }

  const quantity = 1;
  const creditsAmount = pkg.credits * quantity;
  const unitPrice = pkg.price;

  // 实付金额/币种校验（软门闩）：用服务端积分包价格重算期望金额（unitPrice * quantity），
  // 与 Creem 实付额（order.amount，单位分）及 order.currency 比对，阻止 checkout
  // 阶段被篡改的价格/数量套取高价积分包。配置不可比或未开启硬拒时仅告警照常发放。
  const expectedAmount = unitPrice * quantity;
  const amountMatch = evaluateCreemAmountMatch(
    {
      amount: expectedAmount,
      currency: getCreditPackageCurrency(pkg),
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
      packageId,
      orderId: creemOrderId,
    })
  ) {
    if (paymentOrderId) {
      await failCreditPackagePaymentOrder({
        orderId: paymentOrderId,
        userId,
        provider: "creem",
      });
    }
    return;
  }

  if (paymentOrderId) {
    const claim = await claimCreditPackagePaymentOrderForFulfillment({
      orderId: paymentOrderId,
      userId,
      provider: "creem",
      providerTradeNo: creemOrderId,
    });
    if (claim === "fulfilled") return;
    if (claim === "busy") {
      throw new Error("Creem 积分包订单正在履约，请重试通知");
    }
  }

  // 新版 Checkout 以本地订单 ID 作为 sourceRef。payment_order 负责给用户展示状态，
  // credits_batch 唯一索引负责在 webhook 重试或崩溃恢复时防止重复发放；旧订单保持
  // 旧 sourceRef，以免升级后找不到历史幂等记录。
  const sourceRef = paymentOrderId
    ? `creem:${paymentOrderId}`
    : `credit_purchase:${creemOrderId}`;

  try {
    const [existingBatch] = await db
      .select({ id: creditsBatch.id })
      .from(creditsBatch)
      .where(
        and(
          eq(creditsBatch.sourceRef, sourceRef),
          eq(creditsBatch.sourceType, "purchase")
        )
      )
      .limit(1);

    if (!existingBatch) {
      const result = await grantCredits({
        userId,
        amount: creditsAmount,
        sourceType: "purchase",
        debitAccount: `PAYMENT:${creemOrderId}`,
        transactionType: "purchase",
        expiresAt: await getCreditPackExpiresAt(),
        sourceRef,
        description: `Credit pack purchase: ${creditsAmount} credits (${packageId})`,
        metadata: {
          provider: "creem",
          orderId: creemOrderId,
          paymentOrderId,
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
        "Credits granted for credit pack purchase"
      );
    } else {
      logger.info({ sourceRef }, "Credits already granted for purchase");
    }

    if (paymentOrderId) {
      await fulfillCreditPackagePaymentOrder({
        orderId: paymentOrderId,
        userId,
        provider: "creem",
        providerTradeNo: creemOrderId,
      });
    }
  } catch (error) {
    if (paymentOrderId) {
      await releaseCreditPackagePaymentOrderFulfillment({
        orderId: paymentOrderId,
        userId,
        provider: "creem",
        providerTradeNo: creemOrderId,
      });
    }
    logError(error, {
      source: "creem-webhook",
      stage: "grant-credit-purchase",
      userId,
      packageId,
    });
    // S-L2：不再吞异常。grantCredits 对幂等命中（重复 sourceRef）走
    // onConflictDoNothing 并正常返回，不抛错；故能到此 catch 的都是真正的 DB/未知
    // 异常。前置 existingBatch 短路 + credits_batch (source_type, source_ref) 唯一索引
    // 保证 Creem 重投不会双发，因此上抛让外层返回 5xx 触发重投，避免静默漏发积分。
    throw error;
  }
}
