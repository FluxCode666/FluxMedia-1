/** Credits service compatibility facade. Go owns every wallet and ledger operation. */
import type {
  CreditsBatchSource,
  CreditsTransactionType,
  creditsBalance,
  creditsBatch,
  creditsTransaction,
} from "@repo/database/schema";
import {
  requestGoBackendInternalJson,
  requestGoBackendJson,
} from "../http/go-backend";
import type {
  CreditOperationContext,
  CreditOperationContextFallback,
} from "./usage-read-model";

interface GrantCreditsBaseParams {
  /** 用户 ID */
  userId: string;
  /** 积分数量 */
  amount: number;
  /** 来源类型 */
  sourceType: CreditsBatchSource;
  /** 借方账户（资金来源） */
  debitAccount: string;
  /** 过期时间，默认按系统积分有效期计算 */
  expiresAt?: Date | null;
  /** 来源引用（如订单 ID） */
  sourceRef?: string;
  /** 描述 */
  description?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/** 发放参数；退款必须与 refund batch 成对且显式引用原操作。 */
export type GrantCreditsParams =
  | (GrantCreditsBaseParams & {
      sourceType: "refund";
      transactionType: "refund";
      operation: CreditOperationContext;
      sourceRef: string;
    })
  | (GrantCreditsBaseParams & {
      sourceType: Exclude<CreditsBatchSource, "refund">;
      transactionType: Exclude<CreditsTransactionType, "refund">;
      operation?: never;
    });

/**
 * 消费积分参数
 */
interface ConsumeCreditsBaseParams {
  /** 用户 ID */
  userId: string;
  /** 消费数量 */
  amount: number;
  /** 服务名称 */
  serviceName: string;
  /** 描述 */
  description?: string;
  /**
   * 来源引用（幂等键）。传入后，同一 (consumption, sourceRef) 只扣费一次：
   * 重试/并发的重复扣费会被偏唯一索引拒绝并安全跳过，返回首次扣费结果。
   * 不传则行为与历史一致（不幂等）。
   */
  sourceRef?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/** 消费参数必须在业务操作与显式 ledger fallback 中二选一。 */
export type ConsumeCreditsParams = ConsumeCreditsBaseParams &
  (
    | {
        operation: CreditOperationContext;
        operationFallback?: never;
      }
    | {
        operation?: never;
        operationFallback: CreditOperationContextFallback;
      }
  );

/**
 * 积分消费结果
 */
export interface ConsumeCreditsResult {
  /** 是否成功 */
  success: boolean;
  /** 实际消费数量 */
  consumedAmount: number;
  /** 剩余余额 */
  remainingBalance: number;
  /** 交易 ID */
  transactionId: string;
  /** 消费的批次详情 */
  consumedBatches: Array<{
    batchId: string;
    consumedFromBatch: number;
  }>;
  /** 是否为幂等命中（重复 sourceRef，未实际再次扣费） */
  alreadyConsumed?: boolean;
  /** 本次写入或幂等重放最终采用的权威 operation context。 */
  operation: CreditOperationContext;
}

/**
 * 积分余额错误
 */
export class InsufficientCreditsError extends Error {
  constructor(
    public required: number,
    public available: number
  ) {
    super(`积分不足: 需要 ${required}，可用 ${available}`);
    this.name = "InsufficientCreditsError";
  }
}

/**
 * 账户冻结错误
 */
export class AccountFrozenError extends Error {
  constructor(userId: string) {
    super(`用户 ${userId} 的积分账户已被冻结`);
    this.name = "AccountFrozenError";
  }
}

function decodeRow<T>(raw: Record<string, unknown>): T {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase()
    );
    row[name] =
      value != null && /At$/.test(name)
        ? new Date(
            /(?:Z|[+-]\d{2}:\d{2})$/i.test(String(value))
              ? String(value)
              : `${value}Z`
          )
        : value;
  }
  return row as T;
}
function service<T>(
  operation: string,
  userId?: string,
  extra: Record<string, unknown> = {}
) {
  return requestGoBackendInternalJson<T>("/api/internal/credits/service", {
    method: "POST",
    body: JSON.stringify({ operation, userId, ...extra }),
  });
}
type Wallet = typeof creditsBalance.$inferSelect;
type Batch = typeof creditsBatch.$inferSelect;
type Transaction = typeof creditsTransaction.$inferSelect;
type MutationResult = {
  batchId?: string;
  transactionId?: string;
  balance: number;
  replayed: boolean;
};

export async function ensureCreditsBalance(userId: string): Promise<Wallet> {
  return decodeRow<Wallet>(
    await service<Record<string, unknown>>("balance", userId)
  );
}
export const getCreditsBalance = ensureCreditsBalance;

export function ensureRegistrationBonus(userId: string, _bonusAmount: number) {
  return service<{
    granted: boolean;
    alreadyGranted: boolean;
    balance: number;
  }>("registrationBonus", userId);
}
export async function ensureRegistrationBonusExpiry(userId: string) {
  await service("registrationBonusExpiry", userId);
}

export async function grantCredits(params: GrantCreditsParams) {
  const result = await requestGoBackendInternalJson<MutationResult>(
    "/api/internal/credits/operation",
    {
      method: "POST",
      body: JSON.stringify({
        operation: params.sourceType === "refund" ? "refund" : "grant",
        userId: params.userId,
        amount: params.amount,
        type: params.transactionType,
        sourceType: params.sourceType,
        sourceRef: params.sourceRef,
        reason: params.description,
        debitAccount: params.debitAccount,
        expiresAt: params.expiresAt,
        noExpiry: params.expiresAt === null,
        operationType: params.operation?.operationType,
        operationId: params.operation?.operationId,
        operationCreatedAt: params.operation?.operationCreatedAt,
        metadata: params.metadata,
      }),
    }
  );
  return {
    batchId: result.batchId ?? null,
    transactionId: result.transactionId ?? null,
    amount: result.replayed ? 0 : params.amount,
    newBalance: result.balance,
    alreadyGranted: result.replayed,
  };
}

export async function consumeCredits(
  params: ConsumeCreditsParams
): Promise<ConsumeCreditsResult> {
  const result = await requestGoBackendInternalJson<MutationResult>(
    "/api/internal/credits/operation",
    {
      method: "POST",
      body: JSON.stringify({
        operation: "consume",
        userId: params.userId,
        amount: params.amount,
        serviceName: params.serviceName,
        sourceRef: params.sourceRef,
        reason: params.description,
        operationType:
          params.operation?.operationType ??
          params.operationFallback?.operationType,
        operationId: params.operation?.operationId,
        operationCreatedAt: params.operation?.operationCreatedAt,
        metadata: params.metadata,
      }),
    }
  );
  if (!result.transactionId)
    throw new Error("Go billing response omitted the ledger transaction");
  const transaction = decodeRow<Transaction>(
    await service<Record<string, unknown>>("transaction", params.userId, {
      transactionId: result.transactionId,
    })
  );
  if (
    !transaction.operationType ||
    !transaction.operationId ||
    !transaction.operationCreatedAt
  ) {
    throw new Error("The ledger transaction has incomplete operation context");
  }
  const consumed = transaction.metadata?.consumedBatches;
  if (!Array.isArray(consumed))
    throw new Error("The ledger transaction omitted consumed batches");
  return {
    success: true,
    consumedAmount: transaction.amount,
    remainingBalance: result.balance,
    transactionId: transaction.id,
    consumedBatches: consumed as ConsumeCreditsResult["consumedBatches"],
    alreadyConsumed: result.replayed,
    operation: {
      operationType: transaction.operationType,
      operationId: transaction.operationId,
      operationCreatedAt: transaction.operationCreatedAt,
    },
  };
}

export function processExpiredBatches(options?: { userId?: string }) {
  return service<
    Array<{ batchId: string; userId: string; expiredAmount: number }>
  >("processExpired", options?.userId);
}
export async function getUserActiveBatches(userId: string): Promise<Batch[]> {
  return (
    await service<Record<string, unknown>[]>("activeBatches", userId)
  ).map(decodeRow<Batch>);
}
export async function getUserTransactions(
  userId: string,
  options?: { limit?: number; offset?: number }
): Promise<Transaction[]> {
  return (
    await service<Record<string, unknown>[]>("transactions", userId, options)
  ).map(decodeRow<Transaction>);
}
export function getUserTransactionsCount(userId: string): Promise<number> {
  return service<number>("transactionsCount", userId);
}
export async function freezeCreditsAccount(userId: string) {
  await requestGoBackendJson(
    `/api/admin/users/${encodeURIComponent(userId)}/credits/status`,
    { method: "POST", body: JSON.stringify({ status: "frozen" }) }
  );
}
export async function unfreezeCreditsAccount(userId: string) {
  await requestGoBackendJson(
    `/api/admin/users/${encodeURIComponent(userId)}/credits/status`,
    { method: "POST", body: JSON.stringify({ status: "active" }) }
  );
}
