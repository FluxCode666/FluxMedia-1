/**
 * 支付生命周期事务仓储。
 *
 * 使用方：支付宝、Creem、Epay 已验签通知，以及充值/积分包 Checkout 创建路径。
 * 关键依赖：payment_order、payment_lifecycle_event、payment_fulfillment_work_item。
 */
import crypto from "node:crypto";

import { db } from "@repo/database";
import {
  epayOrder,
  paymentFulfillmentWorkItem,
  paymentLifecycleEvent,
  paymentOrder,
} from "@repo/database/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

const providerSchema = z.enum(["alipay_f2f", "creem", "epay"]);
const orderPurposeSchema = z.enum(["credit_top_up", "credit_package"]);
const paymentOrderRowSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  provider: providerSchema,
  purpose: orderPurposeSchema,
  status: z.string().min(1),
  currency: z.string().min(1),
  amount: z.coerce.number().positive(),
  amountMinor: z.coerce.number().int().positive(),
  creditsAmount: z.coerce.number().positive(),
  pricingSnapshot: z.record(z.string(), z.unknown()).and(
    z.object({
      creditsExpiresAt: z.string().datetime().nullable().optional(),
    })
  ),
  providerTradeNo: z.string().nullable(),
});

export type PaymentLifecycleProvider = z.infer<typeof providerSchema>;

export type PaymentFulfillmentFrozenParameters = {
  creditsAmount: number;
  creditSourceRef: string;
  debitAccount: string;
  description: string;
  metadata: Record<string, unknown>;
};

const PAYMENT_EXPIRATION_BATCH_LIMIT = 100;

type PaymentExpirationSqlDatabase = {
  transaction<T>(
    work: (transaction: {
      execute(query: ReturnType<typeof sql>): Promise<unknown>;
    }) => Promise<T>
  ): Promise<T>;
};

type CreemAmountMismatchSqlDatabase = PaymentExpirationSqlDatabase;

/**
 * 构造生产 PostgreSQL 的过期事实写入器，供 DB-free SQL 契约测试注入。
 *
 * @param database 仅暴露短事务与原始 SQL execute 的最小数据库端口。
 * @returns 扫描并幂等写入 expired 生命周期事实的函数。
 * @sideeffect 调用返回函数时会锁定候选订单并写生命周期表，不修改订单状态。
 */
export function createPaymentExpirationRecorder(
  database: PaymentExpirationSqlDatabase
) {
  return async (now = new Date()) =>
    database.transaction(async (tx) => {
      const result = await tx.execute(sql`
        with candidates as (
          select payment.id, payment.provider, payment.expires_at
          from payment_order as payment
          where payment.provider in ('alipay_f2f', 'creem', 'epay')
            and payment.purpose in ('credit_top_up', 'credit_package')
            and payment.status in ('creating', 'pending')
            and payment.expires_at <= ${now}
            and not exists (
              select 1
              from payment_lifecycle_event as event
              where event.payment_order_id = payment.id
                and event.event_type = 'expired'
            )
          order by payment.expires_at asc, payment.id asc
          for update of payment skip locked
          limit ${PAYMENT_EXPIRATION_BATCH_LIMIT}
        )
        insert into payment_lifecycle_event (
          id,
          payment_order_id,
          event_type,
          source_ref,
          occurred_at,
          recorded_at,
          timestamp_source,
          provider
        )
        select
          md5('expired:' || candidate.id),
          candidate.id,
          'expired',
          'expiry:' || candidate.id,
          candidate.expires_at,
          ${now},
          'server_generated',
          candidate.provider
        from candidates as candidate
        on conflict (
          payment_order_id,
          event_type,
          source_ref
        ) do nothing
        returning id
      `);
      const rows = Array.isArray(result)
        ? result
        : ((result as { rows?: unknown[] } | undefined)?.rows ?? []);
      return rows.length;
    });
}

const recordExpiredPaymentLifecycleEventsInDatabase =
  createPaymentExpirationRecorder(db);

/**
 * 为已到期但尚未记录事实的等待支付订单追加幂等 expired 事件。
 *
 * @param now 本轮扫描时间，只用于确定哪些订单已经到期。
 * @returns 本轮新写入的事件数；订单状态保持不变，延迟支付通知仍可继续履约。
 * @sideeffect 在一个短事务内读取未记录订单并追加 append-only 事实。
 */
export async function recordExpiredPaymentLifecycleEvents(now = new Date()) {
  return recordExpiredPaymentLifecycleEventsInDatabase(now);
}

/**
 * 构造 Creem 异常金额的原子终结写入器。
 *
 * @param database 仅暴露短事务和原始 SQL 的数据库端口。
 * @returns 已确认同一交易并写入两个生命周期事实时返回 true。
 * @sideeffect 同一事务将订单置为 failed，并追加 payment_confirmed 与终态失败事实。
 * @failure 订单归属、用途、状态或交易号不匹配时返回 false，且不创建履约工作项。
 */
export function createCreemAmountMismatchRecorder(
  database: CreemAmountMismatchSqlDatabase
) {
  return async (input: {
    orderId: string;
    userId: string;
    providerTradeNo: string;
    eventSourceRef: string;
    occurredAt: Date;
  }) =>
    database.transaction(async (tx) => {
      const recordedAt = new Date();
      const result = await tx.execute(sql`
        WITH matching_order AS (
          SELECT payment.id
          FROM payment_order AS payment
          WHERE payment.id = ${input.orderId}
            AND payment.user_id = ${input.userId}
            AND payment.provider = 'creem'
            AND payment.purpose = 'credit_package'
            AND payment.status IN ('creating', 'pending', 'fulfilling', 'failed')
            AND (
              payment.provider_trade_no IS NULL
              OR payment.provider_trade_no = ${input.providerTradeNo}
            )
          FOR UPDATE
        ), updated_order AS (
          UPDATE payment_order AS payment
          SET status = 'failed',
              provider_trade_no = ${input.providerTradeNo},
              updated_at = ${recordedAt}
          FROM matching_order
          WHERE payment.id = matching_order.id
          RETURNING payment.id
        ), inserted_events AS (
          INSERT INTO payment_lifecycle_event (
            id,
            payment_order_id,
            event_type,
            source_ref,
            occurred_at,
            recorded_at,
            timestamp_source,
            provider
          )
          SELECT
            md5(event.event_type || ':' || updated_order.id || ':' || event.source_ref),
            updated_order.id,
            event.event_type,
            event.source_ref,
            ${input.occurredAt},
            ${recordedAt},
            'provider',
            'creem'
          FROM updated_order
          CROSS JOIN (
            VALUES
              ('payment_confirmed', ${input.eventSourceRef}),
              ('fulfillment_failed_terminal', 'provider_amount_mismatch')
          ) AS event(event_type, source_ref)
          ON CONFLICT (
            payment_order_id,
            event_type,
            source_ref
          ) DO NOTHING
          RETURNING id
        )
        SELECT id FROM updated_order
      `);
      const rows = Array.isArray(result)
        ? result
        : ((result as { rows?: unknown[] } | undefined)?.rows ?? []);
      return rows.length > 0;
    });
}

const rejectCreemPaymentAmountMismatchInDatabase =
  createCreemAmountMismatchRecorder(db);

/**
 * 原子记录已验签的 Creem 支付与异常金额终态。
 *
 * @param input 本地订单身份、Creem 交易号和提供商发生时间。
 * @returns 订单匹配且已原子终结时返回 true。
 * @sideeffect 不创建履约工作项，因此进程崩溃或恢复扫描都不能误发积分。
 */
export async function rejectCreemPaymentAmountMismatch(input: {
  orderId: string;
  userId: string;
  providerTradeNo: string;
  eventSourceRef: string;
  occurredAt: Date;
}) {
  return rejectCreemPaymentAmountMismatchInDatabase(input);
}

/**
 * 已验签且业务校验完成后原子确认支付并创建持久工作项。
 *
 * @param input 订单身份、提供商交易号、通知幂等引用及冻结发放参数。
 * @returns created 表示首次创建；existing 表示同一交易重放；fulfilled 表示已完成。
 * @failure 不同交易号、订单归属或状态冲突时 fail closed。
 */
export async function confirmPaymentAndCreateFulfillmentWorkItem(input: {
  orderId: string;
  userId: string;
  provider: PaymentLifecycleProvider;
  providerTradeNo: string;
  eventSourceRef: string;
  occurredAt: Date;
  timestampSource: "provider" | "server_received";
  fulfillment: PaymentFulfillmentFrozenParameters;
  epayOutTradeNo?: string;
}) {
  return db.transaction(async (tx) => {
    const [rawOrder] = await tx
      .select({
        id: paymentOrder.id,
        userId: paymentOrder.userId,
        provider: paymentOrder.provider,
        purpose: paymentOrder.purpose,
        status: paymentOrder.status,
        currency: paymentOrder.currency,
        amount: paymentOrder.amount,
        amountMinor: paymentOrder.amountMinor,
        creditsAmount: paymentOrder.creditsAmount,
        pricingSnapshot: paymentOrder.pricingSnapshot,
        providerTradeNo: paymentOrder.providerTradeNo,
      })
      .from(paymentOrder)
      .where(eq(paymentOrder.id, input.orderId))
      .limit(1);
    if (!rawOrder) throw new Error("支付订单不存在");
    const order = paymentOrderRowSchema.parse(rawOrder);
    if (
      order.userId !== input.userId ||
      order.provider !== input.provider ||
      (input.provider === "alipay_f2f" && order.purpose !== "credit_top_up") ||
      ((input.provider === "creem" || input.provider === "epay") &&
        order.purpose !== "credit_package") ||
      (order.providerTradeNo && order.providerTradeNo !== input.providerTradeNo)
    ) {
      throw new Error("支付确认与订单归属、用途或交易号不匹配");
    }
    if (Number(order.creditsAmount) !== input.fulfillment.creditsAmount) {
      throw new Error("支付确认积分金额与订单快照不匹配");
    }
    if (order.status === "fulfilled") return "fulfilled" as const;
    const [confirmed] = await tx
      .update(paymentOrder)
      .set({
        status: "fulfilling",
        providerTradeNo: input.providerTradeNo,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentOrder.id, input.orderId),
          eq(paymentOrder.userId, input.userId),
          eq(paymentOrder.provider, input.provider),
          inArray(paymentOrder.status, ["creating", "pending", "fulfilling"]),
          or(
            isNull(paymentOrder.providerTradeNo),
            eq(paymentOrder.providerTradeNo, input.providerTradeNo)
          )
        )
      )
      .returning({ id: paymentOrder.id });
    if (!confirmed) throw new Error("支付订单确认状态已变化");

    if (input.epayOutTradeNo) {
      const [updatedEpay] = await tx
        .update(epayOrder)
        .set({ status: "fulfilling", updatedAt: new Date() })
        .where(
          and(
            eq(epayOrder.outTradeNo, input.epayOutTradeNo),
            inArray(epayOrder.status, ["pending", "fulfilling"])
          )
        )
        .returning({ outTradeNo: epayOrder.outTradeNo });
      if (!updatedEpay) throw new Error("Epay 兼容订单确认状态已变化");
    }

    await tx
      .insert(paymentLifecycleEvent)
      .values({
        id: crypto.randomUUID(),
        paymentOrderId: input.orderId,
        eventType: "payment_confirmed",
        sourceRef: input.eventSourceRef,
        occurredAt: input.occurredAt,
        recordedAt: new Date(),
        timestampSource: input.timestampSource,
        provider: input.provider,
      })
      .onConflictDoNothing({
        target: [
          paymentLifecycleEvent.paymentOrderId,
          paymentLifecycleEvent.eventType,
          paymentLifecycleEvent.sourceRef,
        ],
      });

    const [created] = await tx
      .insert(paymentFulfillmentWorkItem)
      .values({
        id: crypto.randomUUID(),
        paymentOrderId: input.orderId,
        userId: input.userId,
        provider: input.provider,
        providerTradeNo: input.providerTradeNo,
        creditSourceRef: input.fulfillment.creditSourceRef,
        creditsAmount: order.creditsAmount,
        creditsExpiresAt: order.pricingSnapshot.creditsExpiresAt
          ? new Date(order.pricingSnapshot.creditsExpiresAt)
          : null,
        debitAccount: input.fulfillment.debitAccount,
        description: input.fulfillment.description,
        metadata: input.fulfillment.metadata,
        status: "pending",
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({
        target: paymentFulfillmentWorkItem.paymentOrderId,
      })
      .returning({ id: paymentFulfillmentWorkItem.id });
    if (created) return "created" as const;

    const [existing] = await tx
      .select()
      .from(paymentFulfillmentWorkItem)
      .where(eq(paymentFulfillmentWorkItem.paymentOrderId, input.orderId))
      .limit(1);
    if (
      !existing ||
      existing.userId !== input.userId ||
      existing.provider !== input.provider ||
      existing.providerTradeNo !== input.providerTradeNo ||
      existing.creditSourceRef !== input.fulfillment.creditSourceRef ||
      Number(existing.creditsAmount) !== order.creditsAmount ||
      existing.debitAccount !== input.fulfillment.debitAccount ||
      existing.description !== input.fulfillment.description ||
      existing.creditsExpiresAt?.getTime() !==
        (order.pricingSnapshot.creditsExpiresAt
          ? new Date(order.pricingSnapshot.creditsExpiresAt).getTime()
          : undefined)
    ) {
      throw new Error("支付履约工作项幂等重放参数不匹配");
    }
    return "existing" as const;
  });
}
