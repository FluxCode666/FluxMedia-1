import { db } from "@repo/database";
import { creditsBatch } from "@repo/database/schema";
import { CREDIT_CONFIG_DEFAULTS } from "@repo/shared/credits/config";
import { grantCredits } from "@repo/shared/credits/core";
import {
  getCreditPackageCurrency,
  getCreditPackagePrice,
  getRuntimeCreditPackageById,
} from "@repo/shared/credits/packages";
import {
  claimCreditPackagePaymentOrderForFulfillment,
  fulfillCreditPackagePaymentOrder,
  releaseCreditPackagePaymentOrderFulfillment,
} from "@repo/shared/credits/purchase-orders";
import { logEvent, logger } from "@repo/shared/logger";
import {
  claimEpayOrderForFulfillment,
  decodeEpayMetadata,
  type EpayMetadata,
  type EpayVerifyResult,
  getEpayOrderMetadata,
  moneyToCents,
  updateEpayOrderStatus,
} from "@repo/shared/payment/epay";
import { getRuntimeSettingNumber } from "@repo/shared/system-settings";
import { and, eq } from "drizzle-orm";

interface FulfillEpayPaymentResult {
  metadata: EpayMetadata;
}

type EpayFulfillmentSource = "epay-webhook" | "epay-return";

// 进程内去重表：仅为单实例下的最佳努力优化，合并同一订单的并发履约，
// 避免重复的积分订单写入等副作用。跨实例的正确性不依赖此表，而由
// claimEpayOrderForFulfillment 的原子 UPDATE（pending → fulfilling）与
// credits_batch 唯一约束兜底，多实例部署下此表自然失效但不影响幂等。
const inFlightFulfillments = new Map<
  string,
  Promise<FulfillEpayPaymentResult>
>();

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

// 网关回传金额与期望金额（均换算为分）做反欺诈比对，阻止低价/篡改金额套取
// 高额积分订单。允许实付不低于期望，且不超出期望 EPAY_AMOUNT_TOLERANCE_CENTS 分，
// 容忍上游四舍五入/手续费导致的轻微多付；任一侧解析为 NaN 视为不匹配。
// 导出以便 DB-free 单测锁定该金额门闩。
const EPAY_AMOUNT_TOLERANCE_CENTS = 10;

export function isExpectedEpayAmount(
  verifyInfo: EpayVerifyResult,
  expectedAmount: number
) {
  const expectedCents = moneyToCents(expectedAmount);
  const paidCents = moneyToCents(verifyInfo.money);
  if (!Number.isFinite(expectedCents) || !Number.isFinite(paidCents)) {
    return false;
  }

  return (
    paidCents >= expectedCents &&
    paidCents <= expectedCents + EPAY_AMOUNT_TOLERANCE_CENTS
  );
}

export async function fulfillSuccessfulEpayPayment(
  verifyInfo: EpayVerifyResult,
  source: EpayFulfillmentSource
): Promise<FulfillEpayPaymentResult> {
  const runningFulfillment = inFlightFulfillments.get(verifyInfo.outTradeNo);
  if (runningFulfillment) {
    return runningFulfillment;
  }

  const fulfillment = fulfillSuccessfulEpayPaymentInner(verifyInfo, source);
  inFlightFulfillments.set(verifyInfo.outTradeNo, fulfillment);

  try {
    return await fulfillment;
  } finally {
    if (inFlightFulfillments.get(verifyInfo.outTradeNo) === fulfillment) {
      inFlightFulfillments.delete(verifyInfo.outTradeNo);
    }
  }
}

async function fulfillSuccessfulEpayPaymentInner(
  verifyInfo: EpayVerifyResult,
  source: EpayFulfillmentSource
): Promise<FulfillEpayPaymentResult> {
  const metadata =
    decodeEpayMetadata(verifyInfo.param) ??
    (await getEpayOrderMetadata(verifyInfo.outTradeNo));
  if (!metadata || metadata.outTradeNo !== verifyInfo.outTradeNo) {
    await updateEpayOrderStatus(verifyInfo.outTradeNo, "failed");
    throw new Error("Invalid or mismatched Epay metadata");
  }

  // 订阅业务已退役。验签和 metadata 校验完成后直接忽略历史订阅订单，
  // 不领取或更新 epay_order，也不写入订阅记录和积分账本；保留该分支是为了让
  // 历史网关重试得到稳定 2xx，而不是再次触发旧履约逻辑。
  if (metadata.type === "subscription") {
    logger.info(
      {
        provider: "epay",
        eventType: "payment.success",
        eventId: verifyInfo.outTradeNo.slice(0, 128),
      },
      "Ignored retired subscription payment"
    );
    return { metadata };
  }

  // 原子领取订单（pending → fulfilling）。success 只能在积分实际写入后出现，
  // 因而统一结果页不会把“正在履约”提前显示为“积分已到账”。
  const epayClaim = await claimEpayOrderForFulfillment(verifyInfo.outTradeNo);
  if (epayClaim === "fulfilled") return { metadata };
  if (epayClaim === "busy") {
    throw new Error("Epay order is currently being fulfilled");
  }
  if (epayClaim === "missing") {
    throw new Error("Epay order does not exist or cannot be fulfilled");
  }

  let paymentOrderClaimed = false;
  if (metadata.type === "credit_purchase" && metadata.paymentOrderId) {
    const paymentOrderClaim =
      await claimCreditPackagePaymentOrderForFulfillment({
        orderId: metadata.paymentOrderId,
        userId: metadata.userId,
        provider: "epay",
        providerTradeNo: verifyInfo.outTradeNo,
      });
    if (paymentOrderClaim === "fulfilled") {
      await updateEpayOrderStatus(verifyInfo.outTradeNo, "success");
      return { metadata };
    }
    if (paymentOrderClaim === "busy") {
      await updateEpayOrderStatus(verifyInfo.outTradeNo, "pending");
      throw new Error("Credit payment order is currently being fulfilled");
    }
    paymentOrderClaimed = true;
  }

  try {
    await handleCreditPurchase(
      metadata.userId,
      metadata.packageId,
      metadata.quantity ?? 1,
      verifyInfo,
      source
    );
    if (metadata.type === "credit_purchase" && metadata.paymentOrderId) {
      await fulfillCreditPackagePaymentOrder({
        orderId: metadata.paymentOrderId,
        userId: metadata.userId,
        provider: "epay",
        providerTradeNo: verifyInfo.outTradeNo,
      });
    }
    await updateEpayOrderStatus(verifyInfo.outTradeNo, "success");
  } catch (error) {
    // 履约失败：释放领取（fulfilling → pending），以便后续异步通知重试。
    if (paymentOrderClaimed && metadata.paymentOrderId) {
      await releaseCreditPackagePaymentOrderFulfillment({
        orderId: metadata.paymentOrderId,
        userId: metadata.userId,
        provider: "epay",
        providerTradeNo: verifyInfo.outTradeNo,
      });
    }
    await updateEpayOrderStatus(verifyInfo.outTradeNo, "pending");
    throw error;
  }

  return { metadata };
}

async function handleCreditPurchase(
  userId: string,
  packageId: string | undefined,
  quantity: number,
  verifyInfo: EpayVerifyResult,
  source: EpayFulfillmentSource
) {
  if (!packageId) {
    throw new Error("Missing credit package ID");
  }

  const pkg = await getRuntimeCreditPackageById(packageId, {
    includeHidden: true,
  });
  if (!pkg) {
    throw new Error(`Unknown credit package: ${packageId}`);
  }
  if (getCreditPackageCurrency(pkg) !== "CNY") {
    throw new Error("Epay only supports CNY credit packages");
  }
  const normalizedQuantity =
    Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const creditsAmount = pkg.credits * normalizedQuantity;
  const expectedAmount = getCreditPackagePrice(pkg) * normalizedQuantity;

  if (!isExpectedEpayAmount(verifyInfo, expectedAmount)) {
    throw new Error("Epay amount does not match credit package price");
  }

  const sourceRef = `epay:${verifyInfo.outTradeNo}`;
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

  if (existingBatch) {
    logger.info({ source, sourceRef }, "Credit purchase already fulfilled");
    return;
  }

  const expiresAt = await getCreditPackExpiresAt();

  const result = await grantCredits({
    userId,
    amount: creditsAmount,
    sourceType: "purchase",
    debitAccount: `PAYMENT:${verifyInfo.outTradeNo}`,
    transactionType: "purchase",
    expiresAt,
    sourceRef,
    description: `Epay credit pack purchase: ${creditsAmount} credits (${pkg.id})`,
    metadata: {
      provider: "epay",
      outTradeNo: verifyInfo.outTradeNo,
      tradeNo: verifyInfo.tradeNo,
      paymentMethod: verifyInfo.type,
      packageId: pkg.id,
      quantity: normalizedQuantity,
      unitCredits: pkg.credits,
      unitPrice: pkg.price,
      paidMoney: verifyInfo.money,
    },
  });

  logEvent("credits.purchased", {
    userId,
    amount: creditsAmount,
    paymentId: verifyInfo.outTradeNo,
    source: "epay",
    packageId: pkg.id,
    quantity: normalizedQuantity,
  });
  logger.info(
    { source, batchId: result.batchId, userId },
    "Epay credit purchase fulfilled"
  );
}
