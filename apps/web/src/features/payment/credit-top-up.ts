/**
 * 按金额积分充值订单服务。
 *
 * 使用方：UOL bindings（创建/查询/支付宝回调履约）。
 * 关键依赖：payment_order、积分账本、充值配置和支付宝当面付适配器。
 *
 * WHY：支付提供商的通知可能重放、并发到达或在发放积分后进程崩溃。本服务用订单
 * 状态 CAS 作为第一道门闩，并把稳定 sourceRef 交给 grantCredits 的 DB 唯一约束
 * 作为跨进程、跨重试的最终兜底；不包裹 grantCredits，以免嵌套事务。
 */
import crypto from "node:crypto";
import { db } from "@repo/database";
import { paymentOrder } from "@repo/database/schema";
import { CREDIT_CONFIG_DEFAULTS } from "@repo/shared/credits/config";
import { grantCredits } from "@repo/shared/credits/core";
import { getCreditPaymentDisplayStatus } from "@repo/shared/credits/purchase-orders";
import {
  type CreditTopUpPaymentProvider,
  normalizeCreditTopUpConfig,
  quoteCreditTopUp,
} from "@repo/shared/credits/top-up";
import { logError, logEvent } from "@repo/shared/logger";
import {
  createAlipayF2FPrecreate,
  getRuntimeAlipayF2FConfig,
  isRuntimeAlipayF2FConfigured,
  isSuccessfulAlipayTradeStatus,
  parseAlipayCnyAmountMinor,
} from "@repo/shared/payment/alipay-f2f";
import {
  getRuntimeSettingJson,
  getRuntimeSettingNumber,
} from "@repo/shared/system-settings";
import { and, eq, isNull, lt, or } from "drizzle-orm";

const PROCESSING_LEASE_MS = 5 * 60_000;
const CHECKOUT_CREATION_LEASE_MS = 30_000;

type PaymentOrderStatus =
  | "creating"
  | "pending"
  | "fulfilling"
  | "fulfilled"
  | "failed";

type AlipayNotification = {
  outTradeNo: string;
  tradeNo: string;
  tradeStatus: string;
  totalAmount: string;
  appId: string;
  sellerId: string;
};

type PaymentOrderSnapshot = {
  currency: string;
  amountMinor: number;
  creditsAmount: number;
  creditsPerMajorUnit: number;
  creditsExpiresAt: string | null;
  provider: CreditTopUpPaymentProvider;
};

function asPaymentOrderStatus(status: string): PaymentOrderStatus {
  if (
    status === "creating" ||
    status === "pending" ||
    status === "fulfilling" ||
    status === "fulfilled" ||
    status === "failed"
  ) {
    return status;
  }
  throw new Error("未知支付订单状态");
}

function getProviderQrCode(payload: Record<string, unknown> | null) {
  const qrCode = payload?.qrCode;
  return typeof qrCode === "string" && qrCode ? qrCode : null;
}

function getPricingSnapshot(
  value: Record<string, unknown>
): PaymentOrderSnapshot {
  const currency = value.currency;
  const amountMinor = value.amountMinor;
  const creditsAmount = value.creditsAmount;
  const creditsPerMajorUnit = value.creditsPerMajorUnit;
  const creditsExpiresAt = value.creditsExpiresAt;
  const provider = value.provider;
  const normalizedCreditsExpiresAt =
    typeof creditsExpiresAt === "string" ? creditsExpiresAt : null;
  if (
    typeof currency !== "string" ||
    typeof amountMinor !== "number" ||
    typeof creditsAmount !== "number" ||
    typeof creditsPerMajorUnit !== "number" ||
    (creditsExpiresAt !== null &&
      (typeof creditsExpiresAt !== "string" ||
        Number.isNaN(new Date(creditsExpiresAt).getTime()))) ||
    provider !== "alipay_f2f"
  ) {
    throw new Error("支付订单价格快照无效");
  }
  return {
    currency,
    amountMinor,
    creditsAmount,
    creditsPerMajorUnit,
    creditsExpiresAt: normalizedCreditsExpiresAt,
    provider,
  };
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

async function getRuntimeTopUpConfig() {
  return normalizeCreditTopUpConfig(
    await getRuntimeSettingJson("CREDIT_TOP_UP_CONFIG")
  );
}

function toTopUpOrderView(order: {
  id: string;
  status: string;
  currency: string;
  amount: number;
  amountMinor: number;
  creditsAmount: number;
  providerPayload: Record<string, unknown> | null;
  expiresAt: Date | null;
}) {
  return {
    orderId: order.id,
    status: asPaymentOrderStatus(order.status),
    currency: order.currency,
    amount: order.amount,
    amountMinor: order.amountMinor,
    creditsAmount: order.creditsAmount,
    qrCode: getProviderQrCode(order.providerPayload),
    expiresAt: order.expiresAt?.toISOString() ?? null,
  };
}

/** 返回客户端可用的充值渠道，不泄露密钥或未配置通道。 */
export async function getCreditTopUpOptions() {
  const [config, alipayEnabled] = await Promise.all([
    getRuntimeTopUpConfig(),
    isRuntimeAlipayF2FConfigured(),
  ]);
  const currencies = config.currencies
    .filter((item) => item.enabled)
    .map((item) => ({
      ...item,
      providers: item.providers.filter(
        (provider) => provider !== "alipay_f2f" || alipayEnabled
      ),
    }))
    .filter((item) => item.providers.length > 0)
    .slice(0, 16);

  return {
    enabled: config.enabled && currencies.length > 0,
    defaultCurrency: currencies.some(
      (item) => item.currency === config.defaultCurrency
    )
      ? config.defaultCurrency
      : (currencies[0]?.currency ?? config.defaultCurrency),
    currencies,
  };
}

/**
 * 创建（或按 userId + clientRequestId 重取）支付宝积分充值订单。
 *
 * 同一幂等键仅返回同一订单。创建者先用 `creating` 状态租约独占预下单，
 * 其他并发请求只读取已持久化二维码，避免对同一 outTradeNo 重复调用支付宝。
 */
export async function createCreditTopUpCheckout(input: {
  userId: string;
  clientRequestId: string;
  currency: string;
  amountMinor: number;
  provider: CreditTopUpPaymentProvider;
}) {
  if (input.provider !== "alipay_f2f") {
    throw new Error("不支持的充值支付方式");
  }
  if (!(await isRuntimeAlipayF2FConfigured())) {
    throw new Error("支付宝当面付暂未配置或未开启");
  }

  const quote = quoteCreditTopUp({
    config: await getRuntimeTopUpConfig(),
    currency: input.currency,
    amountMinor: input.amountMinor,
    provider: input.provider,
  });
  const now = new Date();
  const creditsExpiresAt = await getCreditPackExpiresAt();
  const orderId = `AT${Date.now()}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const pricingSnapshot: PaymentOrderSnapshot = {
    currency: quote.currency,
    amountMinor: quote.amountMinor,
    creditsAmount: quote.creditsAmount,
    creditsPerMajorUnit: quote.creditsPerMajorUnit,
    creditsExpiresAt: creditsExpiresAt?.toISOString() ?? null,
    provider: quote.provider,
  };

  const inserted = await db
    .insert(paymentOrder)
    .values({
      id: orderId,
      userId: input.userId,
      clientRequestId: input.clientRequestId,
      provider: quote.provider,
      purpose: "credit_top_up",
      status: "creating",
      currency: quote.currency,
      amount: quote.amount,
      amountMinor: quote.amountMinor,
      creditsAmount: quote.creditsAmount,
      pricingSnapshot,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [paymentOrder.userId, paymentOrder.clientRequestId],
    })
    .returning();
  let order =
    inserted[0] ??
    (
      await db
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
  if (!order) throw new Error("无法创建充值订单");

  if (!inserted[0]) {
    const existingView = toTopUpOrderView(order);
    if (existingView.qrCode || existingView.status === "fulfilled") {
      return existingView;
    }
    if (existingView.status !== "creating") {
      throw new Error("该充值订单不可继续支付，请重新发起充值");
    }

    // 预下单请求仍在飞行时交给前端短轮询等待二维码；进程在外呼期间崩溃后，
    // 仅允许租约过期的同幂等请求接管，避免多个进程重复向支付宝建单。
    const creationLeaseExpiresAt = new Date(
      Date.now() - CHECKOUT_CREATION_LEASE_MS
    );
    const [reclaimed] = await db
      .update(paymentOrder)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(paymentOrder.id, order.id),
          eq(paymentOrder.status, "creating"),
          lt(paymentOrder.updatedAt, creationLeaseExpiresAt)
        )
      )
      .returning();
    if (!reclaimed) return existingView;
    order = reclaimed;
  }

  try {
    const precreate = await createAlipayF2FPrecreate({
      outTradeNo: order.id,
      amount: order.amount,
      subject: `FluxMedia 充值 ${order.creditsAmount} Credits`,
    });
    const [updated] = await db
      .update(paymentOrder)
      .set({
        providerPayload: { qrCode: precreate.qrCode },
        expiresAt: precreate.expiresAt,
        status: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(eq(paymentOrder.id, order.id), eq(paymentOrder.status, "creating"))
      )
      .returning();
    if (!updated) throw new Error("充值订单状态已变化，请刷新后重试");

    logEvent("credits.top_up.checkout_created", {
      userId: input.userId,
      orderId: updated.id,
      provider: quote.provider,
      currency: quote.currency,
      amountMinor: quote.amountMinor,
      creditsAmount: quote.creditsAmount,
    });
    return toTopUpOrderView(updated);
  } catch (error) {
    await db
      .update(paymentOrder)
      .set({ status: "failed", updatedAt: new Date() })
      .where(
        and(eq(paymentOrder.id, order.id), eq(paymentOrder.status, "creating"))
      );
    logError(error, {
      source: "credits-top-up-checkout",
      orderId: order.id,
      userId: input.userId,
      provider: input.provider,
    });
    throw error;
  }
}

/** 查询当前用户自己的充值订单；未命中时不泄露其他用户订单存在性。 */
export async function getCreditTopUpOrderStatus(input: {
  userId: string;
  orderId: string;
}) {
  const [order] = await db
    .select()
    .from(paymentOrder)
    .where(
      and(
        eq(paymentOrder.id, input.orderId),
        eq(paymentOrder.userId, input.userId)
      )
    )
    .limit(1);
  if (!order) throw new Error("充值订单不存在");
  return {
    orderId: order.id,
    status: asPaymentOrderStatus(order.status),
    currency: order.currency,
    amount: order.amount,
    creditsAmount: order.creditsAmount,
    qrCode: getProviderQrCode(order.providerPayload),
    expiresAt: order.expiresAt?.toISOString() ?? null,
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
  };
}

/**
 * 查询当前用户自己的统一积分支付订单状态。
 *
 * 支付结果页通过此函数同时读取支付宝按金额充值与 Creem / 易支付积分包订单。
 * 状态仅来自本地服务端记录；第三方页面回跳不参与积分发放或成功判定。
 */
export async function getCreditPaymentStatus(input: {
  userId: string;
  orderId: string;
}) {
  const [order] = await db
    .select()
    .from(paymentOrder)
    .where(
      and(
        eq(paymentOrder.id, input.orderId),
        eq(paymentOrder.userId, input.userId)
      )
    )
    .limit(1);
  if (
    !order ||
    (order.purpose !== "credit_top_up" && order.purpose !== "credit_package")
  ) {
    // 不区分不存在和无归属，避免通过订单 ID 枚举他人的支付信息。
    throw new Error("积分支付订单不存在");
  }
  if (
    order.provider !== "alipay_f2f" &&
    order.provider !== "epay" &&
    order.provider !== "creem"
  ) {
    throw new Error("积分支付订单通道无效");
  }

  return {
    orderId: order.id,
    provider: order.provider,
    status: getCreditPaymentDisplayStatus({
      status: order.status,
      expiresAt: order.expiresAt,
    }),
    currency: order.currency,
    amount: order.amount,
    creditsAmount: order.creditsAmount,
    qrCode:
      order.provider === "alipay_f2f"
        ? getProviderQrCode(order.providerPayload)
        : null,
    expiresAt: order.expiresAt?.toISOString() ?? null,
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
  };
}

/**
 * 履约已验签的支付宝通知。
 *
 * 调用方必须先通过 verifyRuntimeAlipayNotification 验签；此处继续校验订单快照，
 * 因为签名只能证明通知来自支付宝，不能证明它属于当前应用的这笔充值。
 */
export async function fulfillAlipayCreditTopUp(
  notification: AlipayNotification
) {
  if (!isSuccessfulAlipayTradeStatus(notification.tradeStatus)) {
    throw new Error("支付宝交易尚未完成");
  }
  const config = await getRuntimeAlipayF2FConfig();
  if (notification.appId !== config.appId) {
    throw new Error("支付宝回调 App ID 不匹配");
  }
  // 当面付的直连商户可不传 seller_id，支付宝会使用应用签约账户。仍要求
  // 通知携带 seller_id；若管理员配置了 PID，则额外锁定为该商户，覆盖 ISV/
  // 多商户等需要显式隔离的场景。
  if (config.sellerId && notification.sellerId !== config.sellerId) {
    throw new Error("支付宝回调卖家 PID 不匹配");
  }

  const [order] = await db
    .select()
    .from(paymentOrder)
    .where(eq(paymentOrder.id, notification.outTradeNo))
    .limit(1);
  if (order?.provider !== "alipay_f2f" || order.purpose !== "credit_top_up") {
    throw new Error("支付宝充值订单不存在");
  }
  // 同一个支付宝交易号只能归属一笔本地订单。成功订单收到不同交易号的通知
  // 绝不视为幂等命中，避免有效签名的错单通知被静默接受。
  if (order.providerTradeNo && order.providerTradeNo !== notification.tradeNo) {
    throw new Error("支付宝回调交易号不匹配");
  }
  if (order.currency !== "CNY") {
    throw new Error("支付宝当面付订单币种无效");
  }
  if (
    parseAlipayCnyAmountMinor(notification.totalAmount) !== order.amountMinor
  ) {
    throw new Error("支付宝回调金额不匹配");
  }
  // `timeout_express` 约束的是用户付款时间，不是支付宝通知到达时间。不能因网络
  // 延迟拒绝一笔已在超时前成功付款的交易；付款状态和签名才是履约的可信依据。
  if (order.status === "fulfilled") {
    return { orderId: order.id, status: "fulfilled" };
  }

  const leaseExpiresAt = new Date(Date.now() - PROCESSING_LEASE_MS);
  const [claimed] = await db
    .update(paymentOrder)
    // 在发放积分前就写入并唯一约束支付宝交易号。若等到发放完成后再写，
    // 两笔订单的并发回调可能各自发放积分、随后才因唯一索引冲突暴露问题。
    .set({
      status: "fulfilling",
      providerTradeNo: notification.tradeNo,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentOrder.id, order.id),
        or(
          and(
            eq(paymentOrder.status, "pending"),
            or(
              isNull(paymentOrder.providerTradeNo),
              eq(paymentOrder.providerTradeNo, notification.tradeNo)
            )
          ),
          and(
            eq(paymentOrder.status, "fulfilling"),
            lt(paymentOrder.updatedAt, leaseExpiresAt),
            eq(paymentOrder.providerTradeNo, notification.tradeNo)
          )
        )
      )
    )
    .returning();
  if (!claimed) {
    const [currentOrder] = await db
      .select({
        status: paymentOrder.status,
        providerTradeNo: paymentOrder.providerTradeNo,
      })
      .from(paymentOrder)
      .where(eq(paymentOrder.id, order.id))
      .limit(1);
    if (
      currentOrder?.status === "fulfilled" &&
      currentOrder.providerTradeNo === notification.tradeNo
    ) {
      return { orderId: order.id, status: "fulfilled" };
    }
    // 不能在另一个 worker 的履约租约仍有效时向支付宝返回 success。若该 worker
    // 在发放前后崩溃，支付宝停止重试会令订单永久卡住；返回 failure 让通知按
    // 支付宝退避策略重投，租约过期后即可安全接管。
    throw new Error("支付宝充值订单正在履约，请稍后重试通知");
  }

  try {
    const snapshot = getPricingSnapshot(claimed.pricingSnapshot);
    const result = await grantCredits({
      userId: claimed.userId,
      amount: snapshot.creditsAmount,
      sourceType: "purchase",
      debitAccount: `ALIPAY:${notification.tradeNo}`,
      transactionType: "purchase",
      expiresAt: snapshot.creditsExpiresAt
        ? new Date(snapshot.creditsExpiresAt)
        : null,
      sourceRef: `alipay:${claimed.id}`,
      description: `Alipay credit top-up: ${snapshot.creditsAmount} credits`,
      metadata: {
        provider: "alipay_f2f",
        orderId: claimed.id,
        tradeNo: notification.tradeNo,
        currency: snapshot.currency,
        amountMinor: snapshot.amountMinor,
        creditsPerMajorUnit: snapshot.creditsPerMajorUnit,
      },
    });
    await db
      .update(paymentOrder)
      .set({
        status: "fulfilled",
        providerTradeNo: notification.tradeNo,
        fulfilledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentOrder.id, claimed.id),
          eq(paymentOrder.status, "fulfilling")
        )
      );

    logEvent("credits.top_up.fulfilled", {
      userId: claimed.userId,
      orderId: claimed.id,
      tradeNo: notification.tradeNo,
      creditsAmount: snapshot.creditsAmount,
      alreadyGranted: result.alreadyGranted,
    });
    return { orderId: claimed.id, status: "fulfilled" };
  } catch (error) {
    await db
      .update(paymentOrder)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(paymentOrder.id, claimed.id),
          eq(paymentOrder.status, "fulfilling"),
          eq(paymentOrder.providerTradeNo, notification.tradeNo)
        )
      );
    throw error;
  }
}
