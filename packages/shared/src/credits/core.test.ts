import { beforeEach, describe, expect, it, vi } from "vitest";

const internal = vi.hoisted(() => vi.fn());
vi.mock("../http/go-backend", () => ({
  requestGoBackendInternalJson: internal,
  requestGoBackendJson: vi.fn(),
}));

import {
  consumeCredits,
  getCreditsBalance,
  grantCredits,
  processExpiredBatches,
} from "./core";

function readFirstRequestBody(): Record<string, unknown> {
  const body = internal.mock.calls[0]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected the Go credits request body to be JSON text");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

describe("Go credit ledger compatibility boundary", () => {
  beforeEach(() => internal.mockReset());
  it("uses the authoritative ledger context and batches on a replay", async () => {
    internal
      .mockResolvedValueOnce({
        transactionId: "tx",
        balance: 8.75,
        replayed: true,
      })
      .mockResolvedValueOnce({
        id: "tx",
        amount: 1.25,
        operation_type: "image_generation",
        operation_id: "image",
        operation_created_at: "2026-09-13T00:00:00",
        metadata: {
          consumedBatches: [{ batchId: "b", consumedFromBatch: 1.25 }],
        },
      });
    const result = await consumeCredits({
      userId: "user",
      amount: 1.25,
      sourceRef: "image",
      serviceName: "image_generation",
      operation: {
        operationType: "image_generation",
        operationId: "image",
        operationCreatedAt: new Date("2026-09-13T00:00:00Z"),
      },
    });
    expect(result.alreadyConsumed).toBe(true);
    expect(result.operation.operationCreatedAt.toISOString()).toBe(
      "2026-09-13T00:00:00.000Z"
    );
    expect(result.consumedBatches).toEqual([
      { batchId: "b", consumedFromBatch: 1.25 },
    ]);
    expect(result.remainingBalance).toBe(8.75);
    expect(readFirstRequestBody()).toEqual({
      operation: "consume",
      userId: "user",
      amount: 1.25,
      serviceName: "image_generation",
      sourceRef: "image",
      operationType: "image_generation",
      operationId: "image",
      operationCreatedAt: "2026-09-13T00:00:00.000Z",
    });
  });
  it("does not invent an operation identity when a historical ledger is incomplete", async () => {
    internal
      .mockResolvedValueOnce({ transactionId: "tx", balance: 0 })
      .mockResolvedValueOnce({ id: "tx", amount: 1 });
    await expect(
      consumeCredits({
        userId: "user",
        amount: 1,
        serviceName: "service",
        operationFallback: {
          kind: "ledger_transaction",
          operationType: "manual",
        },
      })
    ).rejects.toThrow("incomplete operation context");
  });
  it("preserves original refund identity and explicit nonexpiring batches", async () => {
    internal.mockResolvedValue({
      batchId: "batch",
      transactionId: "refund",
      balance: 10,
      replayed: false,
    });
    const operation = {
      operationType: "video_generation",
      operationId: "video",
      operationCreatedAt: new Date("2026-09-12T12:00:00Z"),
    };
    await grantCredits({
      userId: "user",
      amount: 2.5,
      sourceType: "refund",
      transactionType: "refund",
      debitAccount: "SYSTEM:generation_refund",
      sourceRef: "video:refund",
      operation,
      expiresAt: null,
    });
    expect(readFirstRequestBody()).toEqual({
      operation: "refund",
      userId: "user",
      amount: 2.5,
      type: "refund",
      sourceType: "refund",
      sourceRef: "video:refund",
      debitAccount: "SYSTEM:generation_refund",
      expiresAt: null,
      noExpiry: true,
      operationType: "video_generation",
      operationId: "video",
      operationCreatedAt: "2026-09-12T12:00:00.000Z",
    });
  });
  it("returns actual expiry details and normalizes database timestamps", async () => {
    internal.mockResolvedValueOnce([
      { batchId: "expired", userId: "user", expiredAmount: 2.5 },
    ]);
    await expect(processExpiredBatches({ userId: "user" })).resolves.toEqual([
      { batchId: "expired", userId: "user", expiredAmount: 2.5 },
    ]);
    internal.mockResolvedValueOnce({
      id: "wallet",
      user_id: "user",
      balance: 1.25,
      total_earned: 4,
      created_at: "2026-09-13T00:00:00Z",
    });
    const balance = await getCreditsBalance("user");
    expect(balance.createdAt.toISOString()).toBe("2026-09-13T00:00:00.000Z");
    expect(balance.totalEarned).toBe(4);
  });
});
