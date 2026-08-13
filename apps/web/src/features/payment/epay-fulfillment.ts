/**
 * Epay 已验签通知的支付确认适配器。
 *
 * 使用方：Epay 异步 webhook。职责仅做本地订单/金额校验、原子创建持久履约工作项，
 * 随后在事务外触发 worker；浏览器同步回跳继续只读状态，绝不发放积分。
 */
import { db } from "@repo/database";
import { paymentOrder } from "@repo/database/schema";
import { logger } from "@repo/shared/logger";
import {
  decodeEpayMetadata,
  type EpayMetadata,
  type EpayVerifyResult,
  getEpayOrderMetadata,
  moneyToCents,
} from "@repo/shared/payment/epay";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { processPaymentFulfillmentOrder } from "@/features/payment/payment-fulfillment-service";
import { confirmPaymentAndCreateFulfillmentWorkItem } from "@/features/payment/payment-lifecycle-service";

interface FulfillEpayPaymentResult {
  metadata: EpayMetadata;
}

type EpayFulfillmentSource = "epay-webhook" | "epay-return";

const paymentOrderSnapshotSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  provider: z.literal("epay"),
  purpose: z.literal("credit_package"),
  currency: z.literal("CNY"),
  amount: z.coerce.number().positive(),
  amountMinor: z.coerce.number().int().positive(),
  creditsAmount: z.coerce.number().positive(),
  pricingSnapshot: z.record(z.string(), z.unknown()).and(
    z.object({
      packageId: z.string().min(1),
      quantity: z.number().int().positive(),
      currency: z.literal("CNY"),
      amountMinor: z.number().int().positive(),
      creditsAmount: z.number().positive(),
      creditsExpiresAt: z.string().datetime().nullable().optional(),
    })
  ),
  providerTradeNo: z.string().nullable(),
});

// 进程内去重仅减少单实例重复工作；跨实例正确性由 payment_order CAS、工作项唯一键、
// fencing token 与 credits_batch(source_type, source_ref) 唯一约束共同保证。
const inFlightFulfillments = new Map<
  string,
  Promise<FulfillEpayPaymentResult>
>();

// 网关回传金额与本地订单冻结金额均换算为分。允许轻微多付 10 分以兼容网关
// 四舍五入/手续费，但绝不允许少付；非有限数一律视为不匹配。
const EPAY_AMOUNT_TOLERANCE_CENTS = 10;

/** 判断 Epay 实付金额是否匹配本地订单冻结金额。 */
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

/**
 * 幂等处理一条已验签的 Epay 成功通知。
 *
 * @param verifyInfo 已由路由验签且 tradeStatus 成功的标准化通知。
 * @param source 通知来源，仅用于低敏日志元数据。
 * @returns 已解析业务 metadata。
 * @failure metadata、订单归属、金额或交易号不匹配时 fail closed。
 */
export async function fulfillSuccessfulEpayPayment(
  verifyInfo: EpayVerifyResult,
  source: EpayFulfillmentSource
): Promise<FulfillEpayPaymentResult> {
  const runningFulfillment = inFlightFulfillments.get(verifyInfo.outTradeNo);
  if (runningFulfillment) return runningFulfillment;

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

/** 完成单条 Epay 通知的本地校验、持久确认与事务外履约尝试。 */
async function fulfillSuccessfulEpayPaymentInner(
  verifyInfo: EpayVerifyResult,
  source: EpayFulfillmentSource
): Promise<FulfillEpayPaymentResult> {
  const metadata =
    decodeEpayMetadata(verifyInfo.param) ??
    (await getEpayOrderMetadata(verifyInfo.outTradeNo));
  if (!metadata || metadata.outTradeNo !== verifyInfo.outTradeNo) {
    throw new Error("Invalid or mismatched Epay metadata");
  }
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
  if (!metadata.paymentOrderId || !verifyInfo.tradeNo) {
    throw new Error("Epay 积分通知缺少本地订单或渠道交易号");
  }

  const [rawOrder] = await db
    .select({
      id: paymentOrder.id,
      userId: paymentOrder.userId,
      provider: paymentOrder.provider,
      purpose: paymentOrder.purpose,
      currency: paymentOrder.currency,
      amount: paymentOrder.amount,
      amountMinor: paymentOrder.amountMinor,
      creditsAmount: paymentOrder.creditsAmount,
      pricingSnapshot: paymentOrder.pricingSnapshot,
      providerTradeNo: paymentOrder.providerTradeNo,
    })
    .from(paymentOrder)
    .where(eq(paymentOrder.id, metadata.paymentOrderId))
    .limit(1);
  const order = paymentOrderSnapshotSchema.parse(rawOrder);
  const snapshot = order.pricingSnapshot;
  if (
    order.id !== metadata.paymentOrderId ||
    order.userId !== metadata.userId ||
    snapshot.packageId !== metadata.packageId ||
    snapshot.quantity !== (metadata.quantity ?? 1)
  ) {
    throw new Error("Epay 通知 metadata 与本地订单不匹配");
  }
  if (
    snapshot.currency !== order.currency ||
    snapshot.amountMinor !== order.amountMinor ||
    snapshot.amountMinor !== moneyToCents(order.amount) ||
    snapshot.creditsAmount !== order.creditsAmount
  ) {
    throw new Error("Epay 支付订单冻结快照不一致");
  }
  if (order.providerTradeNo && order.providerTradeNo !== verifyInfo.tradeNo) {
    throw new Error("Epay 渠道交易号与本地订单不匹配");
  }
  if (!isExpectedEpayAmount(verifyInfo, order.amount)) {
    throw new Error("Epay amount does not match local payment order");
  }
  const sourceRef = `epay:${verifyInfo.outTradeNo}`;
  const confirmation = await confirmPaymentAndCreateFulfillmentWorkItem({
    orderId: order.id,
    userId: order.userId,
    provider: "epay",
    // providerTradeNo 必须保存网关真实 trade_no；outTradeNo 继续作为本地订单与积分幂等键。
    providerTradeNo: verifyInfo.tradeNo,
    eventSourceRef: `epay:${verifyInfo.tradeNo}`,
    occurredAt: new Date(),
    timestampSource: "server_received",
    epayOutTradeNo: verifyInfo.outTradeNo,
    fulfillment: {
      creditsAmount: order.creditsAmount,
      creditSourceRef: sourceRef,
      debitAccount: `PAYMENT:${verifyInfo.outTradeNo}`,
      description: `Epay credit pack purchase: ${order.creditsAmount} credits`,
      metadata: {
        provider: "epay",
        outTradeNo: verifyInfo.outTradeNo,
        tradeNo: verifyInfo.tradeNo,
        paymentMethod: verifyInfo.type,
        paymentOrderId: order.id,
        packageId: metadata.packageId,
        quantity: metadata.quantity ?? 1,
        creditsAmount: order.creditsAmount,
        paidMoney: verifyInfo.money,
      },
    },
  });
  if (confirmation !== "fulfilled") {
    await processPaymentFulfillmentOrder(order.id);
  }
  logger.info(
    {
      source,
      orderId: order.id,
      userId: order.userId,
    },
    "Epay payment confirmed and queued for fulfillment"
  );
  return { metadata };
}
