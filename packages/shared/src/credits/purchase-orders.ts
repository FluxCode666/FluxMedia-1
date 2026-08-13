/**
 * 积分包支付订单服务。
 *
 * 使用方：积分包 Checkout、Creem / 易支付履约与统一支付结果页。
 * 关键依赖：payment_order。所有支付渠道先创建本地订单，浏览器只能查询订单，
 * 不能据第三方回跳自行发放积分。
 *
 * WHY：支付成功通知与浏览器回跳的先后顺序并不稳定。把积分包购买也持久化为
 * payment_order 后，用户可以看到准确的“等待支付 → 正在发放 → 已到账”状态，
 * 而发放仍只由服务端 webhook 触发并通过积分账本的幂等约束兜底。
 */
import crypto from "node:crypto";

import { db } from "@repo/database";
import { paymentLifecycleEvent, paymentOrder } from "@repo/database/schema";
import { and, eq } from "drizzle-orm";

export type CreditPackagePaymentProvider = "creem" | "epay";

export type CreditPaymentDisplayStatus =
  | "waiting_payment"
  | "payment_confirmed"
  | "fulfilled"
  | "failed"
  | "expired";

export type CreditPackagePricingSnapshot = {
  packageId: string;
  quantity: number;
  currency: string;
  amountMinor: number;
  creditsAmount: number;
  creditsExpiresAt: string | null;
};

export type CreditPackagePaymentOrder = {
  id: string;
  userId: string;
  provider: CreditPackagePaymentProvider;
  status: string;
  currency: string;
  amount: number;
  amountMinor: number;
  creditsAmount: number;
  expiresAt: Date | null;
  fulfilledAt: Date | null;
  providerPayload: Record<string, unknown> | null;
  providerTradeNo: string | null;
};

function isCreditPackagePaymentProvider(
  value: string
): value is CreditPackagePaymentProvider {
  return value === "creem" || value === "epay";
}

/** 将数据库行转换为本模块稳定使用的订单结构。 */
function toCreditPackagePaymentOrder(order: typeof paymentOrder.$inferSelect) {
  if (
    order.purpose !== "credit_package" ||
    !isCreditPackagePaymentProvider(order.provider)
  ) {
    throw new Error("积分包支付订单类型无效");
  }

  return {
    id: order.id,
    userId: order.userId,
    provider: order.provider,
    status: order.status,
    currency: order.currency,
    amount: order.amount,
    amountMinor: order.amountMinor,
    creditsAmount: order.creditsAmount,
    expiresAt: order.expiresAt,
    fulfilledAt: order.fulfilledAt,
    providerPayload: order.providerPayload,
    providerTradeNo: order.providerTradeNo,
  } satisfies CreditPackagePaymentOrder;
}

/** 从提供商扩展数据中安全读取已创建的 Checkout 地址。 */
export function getCreditPackageCheckoutUrl(
  payload: Record<string, unknown> | null
): string | null {
  const checkoutUrl = payload?.checkoutUrl;
  return typeof checkoutUrl === "string" && checkoutUrl ? checkoutUrl : null;
}

/**
 * 将持久化状态映射为面向用户的状态。
 *
 * `expiresAt` 只控制界面上的重试提示，不能作为拒绝已验签支付通知的依据；
 * 支付平台可能在过期前完成交易、通知却延迟到达，服务端仍必须如实履约。
 */
export function getCreditPaymentDisplayStatus(input: {
  status: string;
  expiresAt: Date | null;
  now?: Date;
}): CreditPaymentDisplayStatus {
  if (input.status === "fulfilled") return "fulfilled";
  if (input.status === "failed") return "failed";
  if (input.status === "fulfilling") return "payment_confirmed";
  if (
    input.expiresAt &&
    input.expiresAt.getTime() <= (input.now ?? new Date()).getTime()
  ) {
    return "expired";
  }
  return "waiting_payment";
}

/**
 * 创建或按用户幂等键重取积分包支付订单。
 *
 * 同一 key 只能对应完全相同的通道和报价，防止客户端重试时把旧订单错误用于
 * 另一份积分包。实际第三方 Checkout 在调用方创建，成功后再写入 providerPayload。
 */
export async function createCreditPackagePaymentOrder(input: {
  userId: string;
  clientRequestId: string;
  provider: CreditPackagePaymentProvider;
  currency: string;
  amount: number;
  amountMinor: number;
  creditsAmount: number;
  pricingSnapshot: CreditPackagePricingSnapshot;
  expiresAt: Date;
}) {
  if (
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor <= 0 ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0 ||
    !Number.isFinite(input.creditsAmount) ||
    input.creditsAmount <= 0
  ) {
    throw new Error("积分包支付金额无效");
  }

  const now = new Date();
  const id = `CP${Date.now()}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const order = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(paymentOrder)
      .values({
        id,
        userId: input.userId,
        clientRequestId: input.clientRequestId,
        provider: input.provider,
        purpose: "credit_package",
        status: "creating",
        currency: input.currency,
        amount: input.amount,
        amountMinor: input.amountMinor,
        creditsAmount: input.creditsAmount,
        pricingSnapshot: input.pricingSnapshot,
        expiresAt: input.expiresAt,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [paymentOrder.userId, paymentOrder.clientRequestId],
      })
      .returning();
    const current =
      inserted[0] ??
      (
        await tx
          .select()
          .from(paymentOrder)
          .where(
            and(
              eq(paymentOrder.userId, input.userId),
              eq(paymentOrder.clientRequestId, input.clientRequestId)
            )
          )
          .limit(1)
      )[0];
    if (current) {
      await tx
        .insert(paymentLifecycleEvent)
        .values({
          id: crypto.randomUUID(),
          paymentOrderId: current.id,
          eventType: "order_created",
          sourceRef: `request:${input.userId}:${input.clientRequestId}`,
          occurredAt: current.createdAt,
          recordedAt: new Date(),
          timestampSource: "server_generated",
          provider: input.provider,
        })
        .onConflictDoNothing({
          target: [
            paymentLifecycleEvent.paymentOrderId,
            paymentLifecycleEvent.eventType,
            paymentLifecycleEvent.sourceRef,
          ],
        });
    }
    return current;
  });
  if (!order) throw new Error("无法创建积分包支付订单");

  const normalized = toCreditPackagePaymentOrder(order);
  const existingPackageId = order.pricingSnapshot.packageId;
  const existingQuantity = order.pricingSnapshot.quantity;
  if (
    normalized.provider !== input.provider ||
    normalized.currency !== input.currency ||
    normalized.amountMinor !== input.amountMinor ||
    normalized.creditsAmount !== input.creditsAmount ||
    existingPackageId !== input.pricingSnapshot.packageId ||
    existingQuantity !== input.pricingSnapshot.quantity
  ) {
    throw new Error("该支付请求已用于另一份积分包");
  }
  return normalized;
}

/**
 * 保存已创建的第三方 Checkout 信息并开放等待支付状态。
 *
 * 只允许从 creating 推进到 pending；这样故障重试不会覆盖已经进入履约或完成的订单。
 */
export async function saveCreditPackageCheckout(input: {
  orderId: string;
  provider: CreditPackagePaymentProvider;
  providerPayload: Record<string, unknown>;
  expiresAt: Date;
}) {
  return db.transaction(async (tx) => {
    const occurredAt = new Date();
    const [updated] = await tx
      .update(paymentOrder)
      .set({
        status: "pending",
        providerPayload: input.providerPayload,
        expiresAt: input.expiresAt,
        updatedAt: occurredAt,
      })
      .where(
        and(
          eq(paymentOrder.id, input.orderId),
          eq(paymentOrder.provider, input.provider),
          eq(paymentOrder.purpose, "credit_package"),
          eq(paymentOrder.status, "creating")
        )
      )
      .returning();
    if (!updated) return null;
    await tx
      .insert(paymentLifecycleEvent)
      .values({
        id: crypto.randomUUID(),
        paymentOrderId: updated.id,
        eventType: "checkout_ready",
        sourceRef: `checkout:${updated.id}`,
        occurredAt,
        recordedAt: new Date(),
        timestampSource: "server_generated",
        provider: input.provider,
      })
      .onConflictDoNothing({
        target: [
          paymentLifecycleEvent.paymentOrderId,
          paymentLifecycleEvent.eventType,
          paymentLifecycleEvent.sourceRef,
        ],
      });
    return toCreditPackagePaymentOrder(updated);
  });
}

/**
 * 在外部 Checkout 创建前冻结提供商侧幂等引用，但不伪造 checkout_ready 事实。
 *
 * @param input 本地订单、通道和提供商引用。
 * @returns 更新后的订单；订单已经离开 creating 时返回 null。
 * @sideeffect 只写 providerPayload，不改变订单状态或追加生命周期事件。
 */
export async function saveCreditPackageProviderReference(input: {
  orderId: string;
  provider: CreditPackagePaymentProvider;
  providerPayload: Record<string, unknown>;
}) {
  const [updated] = await db
    .update(paymentOrder)
    .set({
      providerPayload: input.providerPayload,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentOrder.id, input.orderId),
        eq(paymentOrder.provider, input.provider),
        eq(paymentOrder.purpose, "credit_package"),
        eq(paymentOrder.status, "creating")
      )
    )
    .returning();
  return updated ? toCreditPackagePaymentOrder(updated) : null;
}

/**
 * 记录第三方 Checkout 创建失败。
 *
 * 只把仍处于 creating 的订单终结，已经进入 pending/fulfilling 的订单由其真实
 * 生命周期负责，避免迟到的异常覆盖已成功打开或已付款的订单。
 */
export async function failCreditPackageCheckout(input: {
  orderId: string;
  provider: CreditPackagePaymentProvider;
  sourceRef?: string;
}) {
  return db.transaction(async (tx) => {
    const occurredAt = new Date();
    const [failed] = await tx
      .update(paymentOrder)
      .set({ status: "failed", updatedAt: occurredAt })
      .where(
        and(
          eq(paymentOrder.id, input.orderId),
          eq(paymentOrder.provider, input.provider),
          eq(paymentOrder.purpose, "credit_package"),
          eq(paymentOrder.status, "creating")
        )
      )
      .returning({ id: paymentOrder.id });
    if (!failed) return false;
    await tx
      .insert(paymentLifecycleEvent)
      .values({
        id: crypto.randomUUID(),
        paymentOrderId: input.orderId,
        eventType: "checkout_failed",
        sourceRef: input.sourceRef ?? `checkout:${input.orderId}`,
        occurredAt,
        recordedAt: occurredAt,
        timestampSource: "server_generated",
        provider: input.provider,
      })
      .onConflictDoNothing({
        target: [
          paymentLifecycleEvent.paymentOrderId,
          paymentLifecycleEvent.eventType,
          paymentLifecycleEvent.sourceRef,
        ],
      });
    return true;
  });
}
