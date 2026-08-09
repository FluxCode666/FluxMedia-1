/**
 * 控制台统计回填纯核心的 DB-free 测试。
 *
 * 覆盖命令边界、图片证据、任务归属、relay-only、ledger fallback 与孤立退款。
 */

import { describe, expect, it } from "vitest";

import {
  type BackfillCreditEvidence,
  type BackfillCreditRow,
  buildOutputUsageReconciliationSql,
  creditOperationKey,
  hasReconciliationDifference,
  parseBackfillOptions,
  resolveBackfillCreditOperation,
  resolveBackfillImageOutputCount,
} from "../../../scripts/dashboard-analytics-backfill-core.mjs";

/** 创建可由解析器在批次内持续补充的证据映射。 */
function createEvidence(): BackfillCreditEvidence {
  return {
    imageCreatedAtByKey: new Map(),
    videoCreatedAtByKey: new Map(),
    operationCreatedAtByKey: new Map(),
  };
}

/** 创建最小积分账本测试行。 */
function creditRow(
  overrides: Partial<BackfillCreditRow> = {}
): BackfillCreditRow {
  return {
    id: "transaction-1",
    userId: "user-1",
    type: "consumption",
    amount: "20.00",
    sourceRef: null,
    debitAccount: "WALLET:user-1",
    creditAccount: "SERVICE:manual",
    createdAt: "2026-07-21T01:00:00.000000",
    operationType: null,
    operationId: null,
    operationCreatedAt: null,
    metadata: {},
    ...overrides,
  };
}

describe("dashboard analytics backfill core", () => {
  it("keeps durable usage events after their gallery source was deleted", () => {
    const reconciliationSql = buildOutputUsageReconciliationSql();

    expect(reconciliationSql).toContain(
      "FROM expected\n         LEFT JOIN user_output_usage_event actual"
    );
    expect(reconciliationSql).not.toContain(
      "FULL JOIN user_output_usage_event actual"
    );
    expect(reconciliationSql).toContain(
      "FROM user_output_usage_event\n        GROUP BY user_id"
    );
  });

  it("parses bounded options and rejects unknown arguments", () => {
    expect(
      parseBackfillOptions([
        "--",
        "--model=credit",
        "--batch-size=1000",
        "--reconcile-only",
        "--skip-ready",
      ])
    ).toEqual({
      model: "credit",
      batchSize: 1000,
      reconcileOnly: true,
      skipReady: true,
    });
    expect(() => parseBackfillOptions(["--batch-size=0"])).toThrow(
      /batch-size/
    );
    expect(() => parseBackfillOptions(["--force"])).toThrow(/未知参数/);
  });

  it("uses strict image evidence and blocks an unexplained completed row", () => {
    expect(
      resolveBackfillImageOutputCount({
        status: "completed",
        metadata: { outputImage: { billableImageOutputCount: 4 } },
      })
    ).toEqual({ status: "counted", count: 4 });
    expect(
      resolveBackfillImageOutputCount({
        status: "completed",
        metadata: { chatTextOnlyCharge: { credits: 2 } },
      })
    ).toEqual({ status: "notCounted", count: 0 });
    expect(
      resolveBackfillImageOutputCount({ status: "completed", metadata: {} })
    ).toEqual({ status: "insufficientEvidence", count: null });
  });

  it("attributes image and video rows to authoritative task creation time", () => {
    const evidence = createEvidence();
    evidence.imageCreatedAtByKey.set(
      creditOperationKey("user-1", "task", "image-1"),
      "2026-07-20T23:00:00.000000"
    );
    evidence.videoCreatedAtByKey.set(
      creditOperationKey("user-1", "task", "video-1"),
      "2026-07-20T22:00:00.000000"
    );

    expect(
      resolveBackfillCreditOperation(
        creditRow({
          sourceRef: "image-1:charge",
          metadata: { generationId: "image-1" },
        }),
        evidence
      )
    ).toEqual({
      operationType: "image_generation",
      operationId: "image-1",
      operationCreatedAt: "2026-07-20T23:00:00.000000",
    });
    expect(
      resolveBackfillCreditOperation(
        creditRow({
          id: "transaction-2",
          sourceRef: "adobe-video:video-1",
          metadata: { videoGenerationId: "video-1" },
        }),
        evidence
      )
    ).toEqual({
      operationType: "video_generation",
      operationId: "video-1",
      operationCreatedAt: "2026-07-20T22:00:00.000000",
    });
  });

  it("rejects relay-only history without a persisted task creation time", () => {
    const evidence = createEvidence();
    expect(() =>
      resolveBackfillCreditOperation(
        creditRow({
          sourceRef: "relay-1:charge",
          metadata: { generationId: "relay-1" },
        }),
        evidence
      )
    ).toThrow(/权威 generation/);
  });

  it("uses per-ledger fallback and rejects an orphan refund", () => {
    const evidence = createEvidence();
    expect(
      resolveBackfillCreditOperation(
        creditRow({
          metadata: {
            serviceName: "admin_credit_adjustment",
            adminUserId: "admin-1",
          },
          creditAccount: "SERVICE:admin_credit_adjustment",
        }),
        evidence
      )
    ).toEqual({
      operationType: "admin_credit_adjustment",
      operationId: "transaction-1",
      operationCreatedAt: "2026-07-21T01:00:00.000000",
    });
    expect(() =>
      resolveBackfillCreditOperation(
        creditRow({
          id: "transaction-refund-1",
          type: "refund",
          metadata: { generationId: "missing-1" },
        }),
        evidence
      )
    ).toThrow(/无法唯一关联/);
  });

  it("allows an idempotent ledger fallback without using sourceRef as operation identity", () => {
    const evidence = createEvidence();
    expect(
      resolveBackfillCreditOperation(
        creditRow({
          sourceRef: "client-request-1",
          creditAccount: "SERVICE:custom-service",
          metadata: { serviceName: "custom-service" },
        }),
        evidence
      )
    ).toEqual({
      operationType: "manual_consumption",
      operationId: "transaction-1",
      operationCreatedAt: "2026-07-21T01:00:00.000000",
    });
  });

  it("requires complete operation context to match authoritative task evidence", () => {
    const evidence = createEvidence();
    evidence.imageCreatedAtByKey.set(
      creditOperationKey("user-1", "task", "image-1"),
      "2026-07-20T23:00:00.000000"
    );
    expect(
      resolveBackfillCreditOperation(
        creditRow({
          sourceRef: "image-1:charge",
          operationType: "image_generation",
          operationId: "image-1",
          operationCreatedAt: "2026-07-20T23:00:00.000000",
          metadata: { generationId: "image-1" },
        }),
        evidence
      )
    ).toMatchObject({ operationId: "image-1" });
    expect(() =>
      resolveBackfillCreditOperation(
        creditRow({
          id: "transaction-2",
          sourceRef: "image-1:charge",
          operationType: "image_generation",
          operationId: "image-1",
          operationCreatedAt: "2026-07-21T00:00:00.000000",
          metadata: { generationId: "image-1" },
        }),
        createEvidence()
      )
    ).toThrow(/任务或产物事件/);
  });

  it("does not trust admin metadata without the controlled service account", () => {
    expect(() =>
      resolveBackfillCreditOperation(
        creditRow({
          creditAccount: "SERVICE:manual",
          metadata: { serviceName: "manual", adminUserId: "admin-1" },
        }),
        createEvidence()
      )
    ).not.toThrow();
    expect(() =>
      resolveBackfillCreditOperation(
        creditRow({
          creditAccount: "SERVICE:other",
          metadata: { adminUserId: "admin-1" },
        }),
        createEvidence()
      )
    ).toThrow(/白名单/);
  });

  it("rejects malformed fallback and editable-file legacy consumption without proof", () => {
    const evidence = createEvidence();
    expect(() =>
      resolveBackfillCreditOperation(
        creditRow({
          creditAccount: "SERVICE:different-service",
          metadata: { serviceName: "unclassified-service" },
        }),
        evidence
      )
    ).toThrow(/白名单/);
    expect(() =>
      resolveBackfillCreditOperation(
        creditRow({
          sourceRef: "editable-file:task-1",
          creditAccount: "SERVICE:editable-file-ppt",
          metadata: {
            serviceName: "editable-file-ppt",
            kind: "ppt",
            taskId: "task-1",
          },
        }),
        evidence
      )
    ).toThrow(/权威任务创建时间/);
  });

  it("rejects an image sourceRef that only shares the task suffix", () => {
    const evidence = createEvidence();
    evidence.imageCreatedAtByKey.set(
      creditOperationKey("user-1", "task", "image-1"),
      "2026-07-20T23:00:00.000000"
    );
    expect(() =>
      resolveBackfillCreditOperation(
        creditRow({
          sourceRef: "untrusted:image-1:charge",
          metadata: { generationId: "image-1" },
        }),
        evidence
      )
    ).toThrow(/完整任务格式/);
  });

  it("links a verified image refund to the original task time", () => {
    const evidence = createEvidence();
    evidence.imageCreatedAtByKey.set(
      creditOperationKey("user-1", "task", "image-1"),
      "2026-07-20T23:00:00.000000"
    );
    expect(
      resolveBackfillCreditOperation(
        creditRow({
          id: "refund-1",
          type: "refund",
          debitAccount: "SYSTEM:generation_refund",
          creditAccount: "WALLET:user-1",
          metadata: {
            generationId: "image-1",
            sourceRef: "image-1:generation-error",
          },
        }),
        evidence
      )
    ).toEqual({
      operationType: "image_generation",
      operationId: "image-1",
      operationCreatedAt: "2026-07-20T23:00:00.000000",
    });
  });

  it("detects nonzero reconciliation fields only", () => {
    expect(hasReconciliationDifference({ missing: 0, mismatch: 0 })).toBe(
      false
    );
    expect(hasReconciliationDifference({ missing: 1, mismatch: 0 })).toBe(true);
    expect(hasReconciliationDifference({ missing: "1", mismatch: "0" })).toBe(
      true
    );
  });
});
