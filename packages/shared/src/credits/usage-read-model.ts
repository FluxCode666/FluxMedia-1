/** Pure credit operation identities and projection invariants; storage is explicitly injected. */

const CREDIT_AMOUNT_SCALE = 100;
const CREDIT_AMOUNT_TOLERANCE = 1e-8;

/** 与单笔 sourceRef 解耦的稳定计费操作上下文。 */
export type CreditOperationContext = {
  operationType: string;
  operationId: string;
  operationCreatedAt: Date;
};

/** 一条已写入账本的消费或退款投影贡献。 */
export type CreditUsageContribution = {
  transactionId: string;
  transactionType: "consumption" | "refund";
  transactionCreatedAt: Date;
  userId: string;
  amount: number;
  operation: CreditOperationContext;
};

/** 无业务任务 ID 的手工操作可显式选择账本交易回退。 */
export type CreditOperationContextFallback = {
  kind: "ledger_transaction";
  operationType: string;
};

/** 解析 operation context 所需的账本时点与显式回退策略。 */
export type ResolveCreditOperationContextInput = {
  transactionId: string;
  transactionCreatedAt: Date;
  fallback?: CreditOperationContextFallback;
};

export type CreditUsageProjectionErrorCode =
  | "balance_missing"
  | "contribution_conflict"
  | "operation_context_mismatch"
  | "orphan_refund"
  | "refund_exceeds_gross";

/** 可对账、可分类的财务投影完整性错误。 */
export class CreditUsageProjectionError extends Error {
  /**
   * @param code 稳定失败码，供回填器和对账器分类。
   * @param message 面向运维的简体中文诊断信息。
   */
  constructor(
    public readonly code: CreditUsageProjectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CreditUsageProjectionError";
  }
}

export type InsertCreditUsageContributionResult =
  | "inserted"
  | "duplicate"
  | "conflict";

export type ApplyCreditUsageOperationResult =
  | "applied"
  | CreditUsageProjectionErrorCode;

/**
 * 贡献去重与操作聚合所需的最小事务存储。
 *
 * insert 冲突时实现必须比对全部字段；只有完全一致才能返回 duplicate。
 */
export interface CreditUsageProjectionStore {
  insertContribution: (
    contribution: CreditUsageContribution
  ) => Promise<InsertCreditUsageContributionResult>;
  applyConsumption: (
    contribution: CreditUsageContribution
  ) => Promise<ApplyCreditUsageOperationResult>;
  applyRefund: (
    contribution: CreditUsageContribution
  ) => Promise<ApplyCreditUsageOperationResult>;
}

/** 校验字符串 ID 不为空或纯空白。 */
function assertNonemptyIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new RangeError(`${field} must not be empty`);
  }
  return normalized;
}

/** 校验时间为有效 Date 并返回防御性副本。 */
function assertValidDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${field} must be a valid date`);
  }
  return new Date(value);
}

/** 校验积分金额有限、为正数且最多两位小数。 */
function assertValidCreditAmount(amount: number): void {
  const scaled = amount * CREDIT_AMOUNT_SCALE;
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    Math.abs(scaled - Math.round(scaled)) > CREDIT_AMOUNT_TOLERANCE
  ) {
    throw new RangeError(
      "credit amount must be finite, positive, and have at most two decimals"
    );
  }
}

/** 运行时校验并规范化计费操作上下文。 */
function normalizeCreditOperationContext(
  context: CreditOperationContext
): CreditOperationContext {
  return {
    operationType: assertNonemptyIdentifier(
      context.operationType,
      "operationType"
    ),
    operationId: assertNonemptyIdentifier(context.operationId, "operationId"),
    operationCreatedAt: assertValidDate(
      context.operationCreatedAt,
      "operationCreatedAt"
    ),
  };
}

/**
 * 解析显式操作上下文，或仅在调用方明确声明无业务任务时回退到账本 ID。
 *
 * @param context 业务操作的稳定上下文。
 * @param input 当前账本交易与显式 fallback；不包含 sourceRef，因为严禁解析幂等键。
 * @returns 规范化上下文；业务调用缺失上下文且未声明 fallback 时返回 null。
 */
export function resolveCreditOperationContext(
  context: CreditOperationContext | undefined,
  input: ResolveCreditOperationContextInput
): CreditOperationContext | null {
  if (context) {
    return normalizeCreditOperationContext(context);
  }
  if (!input.fallback) {
    return null;
  }
  return normalizeCreditOperationContext({
    operationType: input.fallback.operationType,
    operationId: input.transactionId,
    operationCreatedAt: input.transactionCreatedAt,
  });
}

/** 校验并规范化完整账本投影贡献。 */
function normalizeCreditUsageContribution(
  contribution: CreditUsageContribution
): CreditUsageContribution {
  assertValidCreditAmount(contribution.amount);
  if (
    contribution.transactionType !== "consumption" &&
    contribution.transactionType !== "refund"
  ) {
    throw new RangeError("transactionType must be consumption or refund");
  }
  return {
    transactionId: assertNonemptyIdentifier(
      contribution.transactionId,
      "transactionId"
    ),
    transactionType: contribution.transactionType,
    transactionCreatedAt: assertValidDate(
      contribution.transactionCreatedAt,
      "transactionCreatedAt"
    ),
    userId: assertNonemptyIdentifier(contribution.userId, "userId"),
    amount: contribution.amount,
    operation: normalizeCreditOperationContext(contribution.operation),
  };
}

/** 将 store 返回的失败码转换为中断整个事务的异常。 */
function throwProjectionFailure(
  result: Exclude<ApplyCreditUsageOperationResult, "applied">,
  contribution: CreditUsageContribution
): never {
  const prefix = `${contribution.transactionType} transaction ${contribution.transactionId}`;
  const messages: Record<CreditUsageProjectionErrorCode, string> = {
    balance_missing: `${prefix}: 退款用户积分账户不存在`,
    contribution_conflict: `${prefix}: 同一交易 ID 的投影内容不一致`,
    operation_context_mismatch: `${prefix}: 计费操作创建时间不一致`,
    orphan_refund: `${prefix}: 退款找不到原计费操作`,
    refund_exceeds_gross: `${prefix}: 退款超过原操作可退毛消费`,
  };
  throw new CreditUsageProjectionError(result, messages[result]);
}

/**
 * 在同一账本事务内应用一条唯一投影贡献。
 *
 * @param store 捕获当前账本事务的投影存储。
 * @param contribution 已写入同一事务账本的消费/退款事实。
 * @returns applied 表示是否首次应用；完全一致的 transaction 重放返回 false。
 * @throws 金额、身份或财务不变量失败时抛出，调用方事务必须整体回滚。
 */
export async function applyCreditUsageContribution(
  store: CreditUsageProjectionStore,
  contribution: CreditUsageContribution
): Promise<{ applied: boolean }> {
  const normalized = normalizeCreditUsageContribution(contribution);
  const inserted = await store.insertContribution(normalized);
  if (inserted === "conflict") {
    throwProjectionFailure("contribution_conflict", normalized);
  }
  if (inserted === "duplicate") {
    return { applied: false };
  }

  const result =
    normalized.transactionType === "consumption"
      ? await store.applyConsumption(normalized)
      : await store.applyRefund(normalized);
  if (result !== "applied") {
    throwProjectionFailure(result, normalized);
  }
  return { applied: true };
}
