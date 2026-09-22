/** Historical PostgreSQL projection adapter, isolated from the Go-backed web runtime. */
import { and, eq, gte, sql } from "drizzle-orm";
import type { db } from "@repo/database";

type CreditUsageProjectionEntryTable = typeof import("@repo/database/schema").creditUsageProjectionEntry;

type ProjectionTransaction = Pick<typeof db, "insert" | "select" | "update">;

async function loadProjectionTables() {
  const schema = await import("@repo/database/schema");
  return {
    creditsBalance: schema.creditsBalance,
    creditUsageOperation: schema.creditUsageOperation,
    creditUsageProjectionEntry: schema.creditUsageProjectionEntry,
  };
}

import type { CreditUsageContribution, CreditUsageProjectionStore } from "./usage-read-model";

/** 比较已存贡献与重放请求的全部财务身份字段。 */
function isSameStoredContribution(
  existing: CreditUsageProjectionEntryTable["$inferSelect"],
  contribution: CreditUsageContribution
): boolean {
  return (
    existing.transactionId === contribution.transactionId &&
    existing.userId === contribution.userId &&
    existing.contributionKind === contribution.transactionType &&
    existing.amount === contribution.amount &&
    existing.operationType === contribution.operation.operationType &&
    existing.operationId === contribution.operation.operationId &&
    existing.operationCreatedAt.getTime() ===
      contribution.operation.operationCreatedAt.getTime() &&
    existing.transactionCreatedAt.getTime() ===
      contribution.transactionCreatedAt.getTime()
  );
}

/**
 * 在已有 Drizzle 事务上构造财务投影 store，不创建或嵌套新事务。
 *
 * @param tx `consumeCredits` 或 `grantCredits` 当前事务。
 * @returns 所有贡献、聚合与累计退款都使用该 tx 的 store。
 */
export function createCreditUsageProjectionStore(
  tx: ProjectionTransaction
): CreditUsageProjectionStore {
  return {
    async insertContribution(contribution) {
      const { creditUsageProjectionEntry } = await loadProjectionTables();
      const inserted = await tx
        .insert(creditUsageProjectionEntry)
        .values({
          transactionId: contribution.transactionId,
          userId: contribution.userId,
          contributionKind: contribution.transactionType,
          amount: contribution.amount,
          operationType: contribution.operation.operationType,
          operationId: contribution.operation.operationId,
          operationCreatedAt: contribution.operation.operationCreatedAt,
          transactionCreatedAt: contribution.transactionCreatedAt,
        })
        .onConflictDoNothing({
          target: creditUsageProjectionEntry.transactionId,
        })
        .returning({
          transactionId: creditUsageProjectionEntry.transactionId,
        });
      if (inserted.length === 1) return "inserted";

      const [existing] = await tx
        .select()
        .from(creditUsageProjectionEntry)
        .where(
          eq(
            creditUsageProjectionEntry.transactionId,
            contribution.transactionId
          )
        )
        .limit(1);
      return existing && isSameStoredContribution(existing, contribution)
        ? "duplicate"
        : "conflict";
    },
    async applyConsumption(contribution) {
      const { creditUsageOperation } = await loadProjectionTables();
      const operation = contribution.operation;
      const updated = await tx
        .insert(creditUsageOperation)
        .values({
          userId: contribution.userId,
          operationType: operation.operationType,
          operationId: operation.operationId,
          operationCreatedAt: operation.operationCreatedAt,
          grossConsumed: contribution.amount,
          refunded: 0,
          netConsumed: contribution.amount,
          createdAt: contribution.transactionCreatedAt,
          updatedAt: contribution.transactionCreatedAt,
        })
        .onConflictDoUpdate({
          target: [
            creditUsageOperation.userId,
            creditUsageOperation.operationType,
            creditUsageOperation.operationId,
          ],
          set: {
            grossConsumed: sql`${creditUsageOperation.grossConsumed} + ${contribution.amount}`,
            netConsumed: sql`${creditUsageOperation.netConsumed} + ${contribution.amount}`,
            updatedAt: contribution.transactionCreatedAt,
          },
          setWhere: eq(
            creditUsageOperation.operationCreatedAt,
            operation.operationCreatedAt
          ),
        })
        .returning({ operationId: creditUsageOperation.operationId });
      return updated.length === 1 ? "applied" : "operation_context_mismatch";
    },
    async applyRefund(contribution) {
      const { creditsBalance, creditUsageOperation } = await loadProjectionTables();
      const operation = contribution.operation;
      const operationKey = and(
        eq(creditUsageOperation.userId, contribution.userId),
        eq(creditUsageOperation.operationType, operation.operationType),
        eq(creditUsageOperation.operationId, operation.operationId)
      );
      const [existing] = await tx
        .select({
          grossConsumed: creditUsageOperation.grossConsumed,
          refunded: creditUsageOperation.refunded,
          operationCreatedAt: creditUsageOperation.operationCreatedAt,
        })
        .from(creditUsageOperation)
        .where(operationKey)
        .limit(1)
        .for("update");
      if (!existing) return "orphan_refund";
      if (
        existing.operationCreatedAt.getTime() !==
        operation.operationCreatedAt.getTime()
      ) {
        return "operation_context_mismatch";
      }
      if (existing.refunded + contribution.amount > existing.grossConsumed) {
        return "refund_exceeds_gross";
      }

      const updated = await tx
        .update(creditUsageOperation)
        .set({
          refunded: sql`${creditUsageOperation.refunded} + ${contribution.amount}`,
          netConsumed: sql`${creditUsageOperation.netConsumed} - ${contribution.amount}`,
          updatedAt: contribution.transactionCreatedAt,
        })
        .where(
          and(
            operationKey,
            eq(
              creditUsageOperation.operationCreatedAt,
              operation.operationCreatedAt
            ),
            gte(
              sql`${creditUsageOperation.grossConsumed} - ${creditUsageOperation.refunded}`,
              contribution.amount
            )
          )
        )
        .returning({ operationId: creditUsageOperation.operationId });
      if (updated.length !== 1) return "refund_exceeds_gross";

      const balance = await tx
        .update(creditsBalance)
        .set({
          totalRefunded: sql`${creditsBalance.totalRefunded} + ${contribution.amount}`,
          updatedAt: contribution.transactionCreatedAt,
        })
        .where(eq(creditsBalance.userId, contribution.userId))
        .returning({ userId: creditsBalance.userId });
      return balance.length === 1 ? "applied" : "balance_missing";
    },
  };
}
