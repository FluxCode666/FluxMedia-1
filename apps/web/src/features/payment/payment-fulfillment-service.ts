/**
 * 支付积分履约处理器。
 *
 * 使用方：已验签支付通知创建持久工作项后同步尝试，以及内部 scheduler 的恢复扫描。
 * 关键依赖：工作项仓储、积分账本和首充奖励；grantCredits 始终在 claim 事务提交后调用。
 */
import { db } from "@repo/database";
import {
  creditsBatch,
  epayOrder,
  paymentFulfillmentWorkItem,
  paymentLifecycleEvent,
  paymentOrder,
} from "@repo/database/schema";
import {
  type GrantCreditsParams,
  grantCredits,
} from "@repo/shared/credits/core";
import { logError, logger } from "@repo/shared/logger";
import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordExpiredPaymentLifecycleEvents } from "@/features/payment/payment-lifecycle-service";
import { invokeReferralFirstPayment } from "@/features/referrals/reward-fulfillment";
import { extractExecuteRows } from "@/server/database-result";

const PAYMENT_FULFILLMENT_LEASE_MS = 5 * 60_000;
const PAYMENT_FULFILLMENT_MAX_BACKOFF_MS = 30 * 60_000;
const PAYMENT_FULFILLMENT_BATCH_LIMIT = 25;

const paymentProviderSchema = z.enum(["alipay_f2f", "creem", "epay"]);
const workItemMetadataSchema = z.record(z.string(), z.unknown());
const claimedWorkItemRowSchema = z.object({
  id: z.string().min(1),
  payment_order_id: z.string().min(1),
  user_id: z.string().min(1),
  provider: paymentProviderSchema,
  provider_trade_no: z.string().min(1),
  credit_source_ref: z.string().min(1),
  credits_amount: z.coerce.number().positive(),
  credits_expires_at: z.coerce.date().nullable(),
  debit_account: z.string().min(1),
  description: z.string().min(1),
  metadata: workItemMetadataSchema,
  lease_token: z.string().min(1),
  attempt_count: z.coerce.number().int().positive(),
});

export type PaymentFulfillmentProvider = z.infer<typeof paymentProviderSchema>;

export type ClaimedPaymentFulfillmentWorkItem = {
  id: string;
  paymentOrderId: string;
  userId: string;
  provider: PaymentFulfillmentProvider;
  providerTradeNo: string;
  creditSourceRef: string;
  creditsAmount: number;
  creditsExpiresAt: Date | null;
  debitAccount: string;
  description: string;
  metadata: Record<string, unknown>;
  leaseToken: string;
  attemptCount: number;
};

export type PaymentFulfillmentCreditsBatch = {
  id: string;
  userId: string;
  amount: number;
};

export interface PaymentFulfillmentProcessorDependencies {
  findCreditsBatch(
    sourceRef: string
  ): Promise<PaymentFulfillmentCreditsBatch | null>;
  grantCredits(input: GrantCreditsParams): Promise<{ batchId: string | null }>;
  loadCreditsBatch(
    batchId: string
  ): Promise<PaymentFulfillmentCreditsBatch | null>;
  renewLease(input: {
    workItemId: string;
    leaseToken: string;
    occurredAt: Date;
  }): Promise<boolean>;
  fulfillReferral(input: {
    orderId: string;
    inviteeUserId: string;
    firstPaymentCredits: number;
    provider: "alipay" | "creem" | "epay";
  }): Promise<void>;
  complete(input: {
    workItemId: string;
    leaseToken: string;
    creditsBatchId: string;
    occurredAt: Date;
  }): Promise<boolean>;
  scheduleRetry(input: {
    workItemId: string;
    leaseToken: string;
    errorCode: string;
    nextAttemptAt: Date;
    occurredAt: Date;
  }): Promise<boolean>;
  failTerminal(input: {
    workItemId: string;
    leaseToken: string;
    errorCode: string;
    occurredAt: Date;
  }): Promise<boolean>;
  now(): Date;
}

export type PaymentFulfillmentProcessResult = {
  status: "succeeded" | "retry_scheduled" | "failed_terminal" | "superseded";
  workItemId: string;
};

/** 将工作项支付提供商映射到首充奖励已有的 provider 枚举。 */
function toReferralProvider(
  provider: PaymentFulfillmentProvider
): "alipay" | "creem" | "epay" {
  return provider === "alipay_f2f" ? "alipay" : provider;
}

/** 按尝试次数计算 30 秒起步、最多 30 分钟的封顶指数退避。 */
export function getPaymentFulfillmentRetryDelayMs(attemptCount: number) {
  const exponent = Math.max(0, Math.min(16, attemptCount - 1));
  return Math.min(PAYMENT_FULFILLMENT_MAX_BACKOFF_MS, 30_000 * 2 ** exponent);
}

/** 核对幂等命中的积分批次归属与金额，任何不一致都 fail closed。 */
function isMatchingCreditsBatch(
  workItem: ClaimedPaymentFulfillmentWorkItem,
  batch: PaymentFulfillmentCreditsBatch
) {
  return (
    batch.userId === workItem.userId && batch.amount === workItem.creditsAmount
  );
}

/**
 * 执行一条已领取工作项。
 *
 * @param workItem 已在独立短事务中用 fencing token 领取的冻结发放参数。
 * @param dependencies 可替换的账本与仓储端口。
 * @returns 本轮终态、重试或被新租约取代的结果。
 * @failure 临时故障写 retry；已存在批次的用户/金额不匹配写确定性终态失败。
 */
export async function processClaimedPaymentFulfillment(
  workItem: ClaimedPaymentFulfillmentWorkItem,
  dependencies: PaymentFulfillmentProcessorDependencies
): Promise<PaymentFulfillmentProcessResult> {
  const occurredAt = dependencies.now();
  try {
    let batch = await dependencies.findCreditsBatch(workItem.creditSourceRef);
    if (batch && !isMatchingCreditsBatch(workItem, batch)) {
      const failed = await dependencies.failTerminal({
        workItemId: workItem.id,
        leaseToken: workItem.leaseToken,
        errorCode: "credits_batch_mismatch",
        occurredAt,
      });
      return {
        status: failed ? "failed_terminal" : "superseded",
        workItemId: workItem.id,
      };
    }

    if (!batch) {
      const renewed = await dependencies.renewLease({
        workItemId: workItem.id,
        leaseToken: workItem.leaseToken,
        occurredAt: dependencies.now(),
      });
      if (!renewed) {
        return { status: "superseded", workItemId: workItem.id };
      }
      const result = await dependencies.grantCredits({
        userId: workItem.userId,
        amount: workItem.creditsAmount,
        sourceType: "purchase",
        debitAccount: workItem.debitAccount,
        transactionType: "purchase",
        expiresAt: workItem.creditsExpiresAt,
        sourceRef: workItem.creditSourceRef,
        description: workItem.description,
        metadata: workItem.metadata,
      });
      batch = result.batchId
        ? await dependencies.loadCreditsBatch(result.batchId)
        : await dependencies.findCreditsBatch(workItem.creditSourceRef);
    }

    if (!batch || !isMatchingCreditsBatch(workItem, batch)) {
      const failed = await dependencies.failTerminal({
        workItemId: workItem.id,
        leaseToken: workItem.leaseToken,
        errorCode: "credits_batch_mismatch",
        occurredAt,
      });
      return {
        status: failed ? "failed_terminal" : "superseded",
        workItemId: workItem.id,
      };
    }

    const renewed = await dependencies.renewLease({
      workItemId: workItem.id,
      leaseToken: workItem.leaseToken,
      occurredAt: dependencies.now(),
    });
    if (!renewed) {
      return { status: "superseded", workItemId: workItem.id };
    }

    try {
      await dependencies.fulfillReferral({
        orderId: workItem.paymentOrderId,
        inviteeUserId: workItem.userId,
        firstPaymentCredits: workItem.creditsAmount,
        provider: toReferralProvider(workItem.provider),
      });
    } catch (error) {
      logError(error, {
        source: "payment-fulfillment",
        stage: "referral-reward",
        orderId: workItem.paymentOrderId,
      });
      throw error;
    }

    const completed = await dependencies.complete({
      workItemId: workItem.id,
      leaseToken: workItem.leaseToken,
      creditsBatchId: batch.id,
      occurredAt,
    });
    if (!completed) {
      return { status: "superseded", workItemId: workItem.id };
    }
    return { status: "succeeded", workItemId: workItem.id };
  } catch (error) {
    const nextAttemptAt = new Date(
      occurredAt.getTime() +
        getPaymentFulfillmentRetryDelayMs(workItem.attemptCount)
    );
    const scheduled = await dependencies.scheduleRetry({
      workItemId: workItem.id,
      leaseToken: workItem.leaseToken,
      errorCode: "fulfillment_attempt_failed",
      nextAttemptAt,
      occurredAt,
    });
    if (scheduled) {
      logError(error, {
        source: "payment-fulfillment",
        stage: "attempt",
        workItemId: workItem.id,
        orderId: workItem.paymentOrderId,
        attemptCount: workItem.attemptCount,
      });
      return { status: "retry_scheduled", workItemId: workItem.id };
    }
    return { status: "superseded", workItemId: workItem.id };
  }
}

/** 从 PostgreSQL 原始 claim 行构造经过 Zod 校验的稳定工作项。 */
function parseClaimedWorkItem(row: unknown): ClaimedPaymentFulfillmentWorkItem {
  const parsed = claimedWorkItemRowSchema.parse(row);
  return {
    id: parsed.id,
    paymentOrderId: parsed.payment_order_id,
    userId: parsed.user_id,
    provider: parsed.provider,
    providerTradeNo: parsed.provider_trade_no,
    creditSourceRef: parsed.credit_source_ref,
    creditsAmount: parsed.credits_amount,
    creditsExpiresAt: parsed.credits_expires_at,
    debitAccount: parsed.debit_account,
    description: parsed.description,
    metadata: parsed.metadata,
    leaseToken: parsed.lease_token,
    attemptCount: parsed.attempt_count,
  };
}

/** 读取并核对积分批次；sourceRef 查询只允许 purchase 来源。 */
async function findCreditsBatch(
  sourceRef: string
): Promise<PaymentFulfillmentCreditsBatch | null> {
  const [batch] = await db
    .select({
      id: creditsBatch.id,
      userId: creditsBatch.userId,
      amount: creditsBatch.amount,
    })
    .from(creditsBatch)
    .where(
      and(
        eq(creditsBatch.sourceType, "purchase"),
        eq(creditsBatch.sourceRef, sourceRef)
      )
    )
    .limit(1);
  return batch
    ? { id: batch.id, userId: batch.userId, amount: Number(batch.amount) }
    : null;
}

/** 按批次 ID 读取积分发放结果并转换数值字段。 */
async function loadCreditsBatch(
  batchId: string
): Promise<PaymentFulfillmentCreditsBatch | null> {
  const [batch] = await db
    .select({
      id: creditsBatch.id,
      userId: creditsBatch.userId,
      amount: creditsBatch.amount,
    })
    .from(creditsBatch)
    .where(eq(creditsBatch.id, batchId))
    .limit(1);
  return batch
    ? { id: batch.id, userId: batch.userId, amount: Number(batch.amount) }
    : null;
}

/** 在财务或推广副作用前续租，并拒绝已经过期或被接管的旧 fencing token。 */
async function renewPaymentFulfillmentLease(input: {
  workItemId: string;
  leaseToken: string;
  occurredAt: Date;
}) {
  const [renewed] = await db
    .update(paymentFulfillmentWorkItem)
    .set({
      leaseExpiresAt: new Date(
        input.occurredAt.getTime() + PAYMENT_FULFILLMENT_LEASE_MS
      ),
      updatedAt: input.occurredAt,
    })
    .where(
      and(
        eq(paymentFulfillmentWorkItem.id, input.workItemId),
        eq(paymentFulfillmentWorkItem.status, "processing"),
        eq(paymentFulfillmentWorkItem.leaseToken, input.leaseToken),
        gt(paymentFulfillmentWorkItem.leaseExpiresAt, input.occurredAt)
      )
    )
    .returning({ id: paymentFulfillmentWorkItem.id });
  return Boolean(renewed);
}

/**
 * 使用 SKIP LOCKED 领取一条到期工作项。
 *
 * @param now 当前数据库业务时间。
 * @returns 已提交的工作项，未命中返回 null。
 * @sideeffect 短事务写 processing、fencing token、租约和尝试次数。
 */
export async function claimNextPaymentFulfillmentWorkItem(
  now = new Date()
): Promise<ClaimedPaymentFulfillmentWorkItem | null> {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + PAYMENT_FULFILLMENT_LEASE_MS);
  const result = await db.transaction(async (tx) =>
    tx.execute(sql`
      WITH candidate AS (
        SELECT id
        FROM payment_fulfillment_work_item
        WHERE (
          status IN ('pending', 'retry')
          AND next_attempt_at <= ${now}
        ) OR (
          status = 'processing'
          AND lease_expires_at <= ${now}
        )
        ORDER BY next_attempt_at ASC, created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE payment_fulfillment_work_item AS work
      SET status = 'processing',
          attempt_count = work.attempt_count + 1,
          lease_token = ${leaseToken},
          lease_expires_at = ${leaseExpiresAt},
          updated_at = ${now}
      FROM candidate
      WHERE work.id = candidate.id
      RETURNING work.*
    `)
  );
  const row = extractExecuteRows(result)[0];
  return row ? parseClaimedWorkItem(row) : null;
}

/** 用 fencing token 完成工作项、支付订单和 Epay 兼容表。 */
async function completePaymentFulfillment(input: {
  workItemId: string;
  leaseToken: string;
  creditsBatchId: string;
  occurredAt: Date;
}) {
  return db.transaction(async (tx) => {
    const [workItem] = await tx
      .update(paymentFulfillmentWorkItem)
      .set({
        status: "succeeded",
        creditsBatchId: input.creditsBatchId,
        completedAt: input.occurredAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        updatedAt: input.occurredAt,
      })
      .where(
        and(
          eq(paymentFulfillmentWorkItem.id, input.workItemId),
          eq(paymentFulfillmentWorkItem.status, "processing"),
          eq(paymentFulfillmentWorkItem.leaseToken, input.leaseToken)
        )
      )
      .returning();
    if (!workItem) return false;

    const [fulfilledOrder] = await tx
      .update(paymentOrder)
      .set({
        status: "fulfilled",
        providerTradeNo: workItem.providerTradeNo,
        fulfilledAt: input.occurredAt,
        updatedAt: input.occurredAt,
      })
      .where(
        and(
          eq(paymentOrder.id, workItem.paymentOrderId),
          eq(paymentOrder.status, "fulfilling"),
          eq(paymentOrder.providerTradeNo, workItem.providerTradeNo)
        )
      )
      .returning({ id: paymentOrder.id });
    if (!fulfilledOrder) {
      throw new Error("支付订单履约 fencing 条件已变化");
    }
    if (workItem.provider === "epay") {
      await tx
        .update(epayOrder)
        .set({ status: "success", updatedAt: input.occurredAt })
        .where(eq(epayOrder.outTradeNo, workItem.creditSourceRef.slice(5)));
    }
    await tx
      .insert(paymentLifecycleEvent)
      .values({
        id: crypto.randomUUID(),
        paymentOrderId: workItem.paymentOrderId,
        eventType: "fulfillment_succeeded",
        sourceRef: `work:${workItem.id}`,
        occurredAt: input.occurredAt,
        recordedAt: new Date(),
        timestampSource: "server_received",
        provider: workItem.provider,
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

/** 用 fencing token 写回可恢复失败和下一次退避时间。 */
async function schedulePaymentFulfillmentRetry(input: {
  workItemId: string;
  leaseToken: string;
  errorCode: string;
  nextAttemptAt: Date;
  occurredAt: Date;
}) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(paymentFulfillmentWorkItem)
      .set({
        status: "retry",
        nextAttemptAt: input.nextAttemptAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: input.errorCode,
        updatedAt: input.occurredAt,
      })
      .where(
        and(
          eq(paymentFulfillmentWorkItem.id, input.workItemId),
          eq(paymentFulfillmentWorkItem.status, "processing"),
          eq(paymentFulfillmentWorkItem.leaseToken, input.leaseToken)
        )
      )
      .returning();
    if (!updated) return false;
    await tx
      .insert(paymentLifecycleEvent)
      .values({
        id: crypto.randomUUID(),
        paymentOrderId: updated.paymentOrderId,
        eventType: "fulfillment_attempt_failed",
        sourceRef: `work:${updated.id}:attempt:${updated.attemptCount}`,
        occurredAt: input.occurredAt,
        recordedAt: new Date(),
        timestampSource: "server_received",
        provider: updated.provider,
      })
      .onConflictDoNothing({
        target: [
          paymentLifecycleEvent.paymentOrderId,
          paymentLifecycleEvent.eventType,
          paymentLifecycleEvent.sourceRef,
        ],
      });
    if (updated.provider === "epay") {
      await tx
        .update(epayOrder)
        .set({ status: "fulfilling", updatedAt: input.occurredAt })
        .where(eq(epayOrder.outTradeNo, updated.creditSourceRef.slice(5)));
    }
    return true;
  });
}

/** 用 fencing token 写入确定性永久失败，不能被旧 worker 覆盖。 */
async function failPaymentFulfillmentTerminal(input: {
  workItemId: string;
  leaseToken: string;
  errorCode: string;
  occurredAt: Date;
}) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(paymentFulfillmentWorkItem)
      .set({
        status: "failed",
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: input.errorCode,
        completedAt: input.occurredAt,
        updatedAt: input.occurredAt,
      })
      .where(
        and(
          eq(paymentFulfillmentWorkItem.id, input.workItemId),
          eq(paymentFulfillmentWorkItem.status, "processing"),
          eq(paymentFulfillmentWorkItem.leaseToken, input.leaseToken)
        )
      )
      .returning();
    if (!updated) return false;
    await tx
      .update(paymentOrder)
      .set({ status: "failed", updatedAt: input.occurredAt })
      .where(
        and(
          eq(paymentOrder.id, updated.paymentOrderId),
          eq(paymentOrder.status, "fulfilling")
        )
      );
    if (updated.provider === "epay") {
      await tx
        .update(epayOrder)
        .set({ status: "failed", updatedAt: input.occurredAt })
        .where(eq(epayOrder.outTradeNo, updated.creditSourceRef.slice(5)));
    }
    await tx
      .insert(paymentLifecycleEvent)
      .values({
        id: crypto.randomUUID(),
        paymentOrderId: updated.paymentOrderId,
        eventType: "fulfillment_failed_terminal",
        sourceRef: `work:${updated.id}:terminal`,
        occurredAt: input.occurredAt,
        recordedAt: new Date(),
        timestampSource: "server_received",
        provider: updated.provider,
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

const defaultProcessorDependencies: PaymentFulfillmentProcessorDependencies = {
  findCreditsBatch,
  grantCredits,
  loadCreditsBatch,
  renewLease: renewPaymentFulfillmentLease,
  async fulfillReferral(input) {
    await invokeReferralFirstPayment(input);
  },
  complete: completePaymentFulfillment,
  scheduleRetry: schedulePaymentFulfillmentRetry,
  failTerminal: failPaymentFulfillmentTerminal,
  now: () => new Date(),
};

/** 立即尝试处理指定支付订单已创建的工作项，未可领取时安全返回。 */
export async function processPaymentFulfillmentOrder(
  paymentOrderId: string,
  dependencies = defaultProcessorDependencies
): Promise<PaymentFulfillmentProcessResult | null> {
  const now = dependencies.now();
  const leaseToken = crypto.randomUUID();
  const [claimed] = await db
    .update(paymentFulfillmentWorkItem)
    .set({
      status: "processing",
      attemptCount: sql`${paymentFulfillmentWorkItem.attemptCount} + 1`,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + PAYMENT_FULFILLMENT_LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentFulfillmentWorkItem.paymentOrderId, paymentOrderId),
        or(
          and(
            inArray(paymentFulfillmentWorkItem.status, ["pending", "retry"]),
            lte(paymentFulfillmentWorkItem.nextAttemptAt, now)
          ),
          and(
            eq(paymentFulfillmentWorkItem.status, "processing"),
            lte(paymentFulfillmentWorkItem.leaseExpiresAt, now)
          )
        )
      )
    )
    .returning();
  if (!claimed) return null;
  return processClaimedPaymentFulfillment(
    {
      id: claimed.id,
      paymentOrderId: claimed.paymentOrderId,
      userId: claimed.userId,
      provider: paymentProviderSchema.parse(claimed.provider),
      providerTradeNo: claimed.providerTradeNo,
      creditSourceRef: claimed.creditSourceRef,
      creditsAmount: Number(claimed.creditsAmount),
      creditsExpiresAt: claimed.creditsExpiresAt,
      debitAccount: claimed.debitAccount,
      description: claimed.description,
      metadata: workItemMetadataSchema.parse(claimed.metadata),
      leaseToken,
      attemptCount: claimed.attemptCount,
    },
    dependencies
  );
}

/**
 * 仅供已验签通知使用的确定性终态失败入口。
 *
 * @param input 支付订单、交易号和不可恢复错误代码。
 * @sideeffect 创建同一冻结参数工作项后以 fencing token 原子终结订单并记录事实。
 */
export async function failPaymentFulfillmentOrderTerminal(input: {
  paymentOrderId: string;
  errorCode: string;
}) {
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  const [claimed] = await db
    .update(paymentFulfillmentWorkItem)
    .set({
      status: "processing",
      attemptCount: sql`${paymentFulfillmentWorkItem.attemptCount} + 1`,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + PAYMENT_FULFILLMENT_LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentFulfillmentWorkItem.paymentOrderId, input.paymentOrderId),
        inArray(paymentFulfillmentWorkItem.status, ["pending", "retry"])
      )
    )
    .returning({ id: paymentFulfillmentWorkItem.id });
  if (!claimed) return false;
  return failPaymentFulfillmentTerminal({
    workItemId: claimed.id,
    leaseToken,
    errorCode: input.errorCode,
    occurredAt: now,
  });
}

/** 每分钟恢复一批到期或陈旧租约工作项，单项失败不阻断同批其他订单。 */
export async function runPaymentFulfillmentRecovery() {
  const expiredEventCount = await recordExpiredPaymentLifecycleEvents();
  let claimedCount = 0;
  let succeededCount = 0;
  let retryCount = 0;
  let failedCount = 0;
  let supersededCount = 0;
  for (let index = 0; index < PAYMENT_FULFILLMENT_BATCH_LIMIT; index += 1) {
    const claimed = await claimNextPaymentFulfillmentWorkItem();
    if (!claimed) break;
    claimedCount += 1;
    try {
      const result = await processClaimedPaymentFulfillment(
        claimed,
        defaultProcessorDependencies
      );
      if (result.status === "succeeded") succeededCount += 1;
      else if (result.status === "retry_scheduled") retryCount += 1;
      else if (result.status === "failed_terminal") failedCount += 1;
      else supersededCount += 1;
    } catch (error) {
      logError(error, {
        source: "payment-fulfillment-recovery",
        workItemId: claimed.id,
      });
      retryCount += 1;
    }
  }
  logger.info(
    {
      source: "payment-fulfillment-recovery",
      expiredEventCount,
      claimedCount,
      succeededCount,
      retryCount,
      failedCount,
      supersededCount,
    },
    "Payment fulfillment recovery completed"
  );
  return {
    claimedCount,
    succeededCount,
    retryCount,
    failedCount,
    supersededCount,
    expiredEventCount,
  };
}
