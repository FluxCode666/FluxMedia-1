/**
 * dashboard-analytics-backfill-core.mjs 的 TypeScript 类型公开面。
 *
 * 仅供 Web 的 DB-free Vitest 与编辑器校验使用；运行时实现保持无构建依赖的原生 MJS。
 */

export type BackfillOptions = {
  model: "all" | "output" | "credit";
  batchSize: number;
  reconcileOnly: boolean;
  skipReady: boolean;
};

export type BackfillCreditRow = {
  id: string;
  userId: string;
  type: "consumption" | "refund";
  amount: string;
  sourceRef: string | null;
  debitAccount: string;
  creditAccount: string;
  createdAt: string;
  operationType: string | null;
  operationId: string | null;
  operationCreatedAt: string | null;
  metadata: unknown;
};

export type BackfillCreditEvidence = {
  imageCreatedAtByKey: Map<string, string>;
  videoCreatedAtByKey: Map<string, string>;
  operationCreatedAtByKey: Map<string, string>;
  blockRepairParentByOutputKey?: Map<
    string,
    { generationId: string; createdAt: string }
  >;
};

export type BackfillCreditOperation = {
  operationType: string;
  operationId: string;
  operationCreatedAt: string;
};

export function creditOperationKey(
  userId: string,
  operationType: string,
  operationId: string
): string;

export function parseBackfillOptions(argumentsList: string[]): BackfillOptions;

export function buildOutputUsageReconciliationSql(): string;

export function resolveBackfillImageOutputCount(row: {
  status: string;
  storageKey?: string | null;
  metadata?: unknown;
}):
  | { status: "counted"; count: number }
  | { status: "notCounted"; count: 0 }
  | { status: "insufficientEvidence"; count: null };

export function resolveBackfillCreditOperation(
  row: BackfillCreditRow,
  evidence: BackfillCreditEvidence
): BackfillCreditOperation;

export function hasReconciliationDifference(
  result: Record<string, number | string>
): boolean;
