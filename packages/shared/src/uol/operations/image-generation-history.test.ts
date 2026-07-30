/**
 * 统一生成历史 UOL 注册测试。
 *
 * 证明操作仅使用 Principal 用户身份、拒绝调用方 userId，并保持
 * 只读、无副作用且不暴露内部字段。
 */

import { describe, expect, it } from "vitest";
import { getOperation } from "../registry";
import "./image-generation";

describe("image history UOL contract", () => {
  it("registers a principal-scoped natural read without caller identity", () => {
    const operation = getOperation("image.listMyHistoryRecords");
    expect(operation).toMatchObject({
      access: { kind: "protected" },
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
    expect(operation?.input.safeParse({ userId: "another-user" }).success).toBe(
      false
    );
  });

  it("rejects raw metadata and storage identifiers in output", () => {
    const operation = getOperation("image.listMyHistoryRecords");
    const parsed = operation?.output.safeParse({
      asOf: "2026-07-22T12:00:00.000Z",
      records: [
        {
          kind: "image",
          id: "image-1",
          prompt: "prompt",
          revisedPrompt: null,
          model: "gpt-image-2",
          size: "1024x1024",
          status: "completed",
          creditsConsumed: 10,
          creditDetails: null,
          promptRepairNotice: null,
          referenceImages: [],
          error: null,
          imageUrl: null,
          createdAt: "2026-07-22T11:00:00.000Z",
          completedAt: null,
          metadata: { secret: true },
          storageKey: "internal/key.png",
        },
      ],
      modelOptions: ["gpt-image-2"],
      nextCursor: null,
      previousCursor: null,
    });

    expect(parsed?.success).toBe(false);
  });

  it("registers a human-only global read for all three admin roles", () => {
    const operation = getOperation("image.listAdminHistoryRecords");
    expect(operation).toMatchObject({
      access: {
        kind: "roles",
        roles: ["observer_admin", "admin", "super_admin"],
      },
      agentExposure: "human-only",
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
    expect(operation?.input.safeParse({ userId: "forged-user" }).success).toBe(
      false
    );
  });
});
