/**
 * 统一生成历史 UOL 注册测试。
 *
 * 证明操作仅使用 Principal 用户身份、拒绝调用方 userId，并保持
 * 只读、无副作用且不暴露内部字段。
 */

import { describe, expect, it } from "vitest";
import { getOperation } from "../registry";
import "./image-generation";

const publicVideoBilling = {
  kind: "snapshot" as const,
  mode: "per_item" as const,
  unit: "item" as const,
  unitPrice: 3,
  durationSeconds: 8,
  quotedCredits: 3,
  actualCredits: 0,
};

/** 构造个人与管理员历史契约共用的公共视频记录。 */
function createPublicVideoHistoryRecord() {
  return {
    kind: "video" as const,
    id: "video-1",
    prompt: "prompt",
    model: "seedance2",
    status: "completed" as const,
    creditsConsumed: 0,
    error: null,
    createdAt: "2026-07-22T11:00:00.000Z",
    completedAt: "2026-07-22T11:01:00.000Z",
    processingDurationSeconds: 60,
    resolution: "1080p",
    duration: 8,
    aspectRatio: "16:9",
    generateAudio: false,
    input: { mode: "none" as const, count: 0 },
    billing: publicVideoBilling,
    videoUrl: null,
  };
}

/** 构造统一历史 operation 的完整分页输出。 */
function createHistoryOutput(record: Record<string, unknown>) {
  return {
    asOf: "2026-07-22T12:00:00.000Z",
    page: 1,
    pageSize: 20,
    totalCount: 1,
    records: [record],
    modelOptions: ["seedance2"],
    nextCursor: null,
    previousCursor: null,
  };
}

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

  it("个人与管理员历史只接受公共视频 billing DTO", () => {
    const personalOperation = getOperation("image.listMyHistoryRecords");
    const adminOperation = getOperation("image.listAdminHistoryRecords");
    const personalRecord = createPublicVideoHistoryRecord();
    const adminRecord = {
      ...personalRecord,
      backendAccount: { id: "account-1", name: "供应商账号" },
      submissionAttempts: [],
      userId: "user-1",
      userEmail: "member@example.com",
    };
    const personalParsed = personalOperation?.output.safeParse(
      createHistoryOutput(personalRecord)
    );
    const adminParsed = adminOperation?.output.safeParse({
      ...createHistoryOutput(adminRecord),
      userOptions: [{ id: "user-1", email: "member@example.com" }],
    });

    expect(personalParsed?.success).toBe(true);
    expect(adminParsed?.success).toBe(true);

    const internalRecord = {
      ...personalRecord,
      billing: {
        ...publicVideoBilling,
        billingGroupId: "internal-group",
        digest: "internal-digest",
        priceSource: "group_resolution",
        revision: 9,
      },
    };
    expect(
      personalOperation?.output.safeParse(createHistoryOutput(internalRecord))
        .success
    ).toBe(false);
    expect(
      adminOperation?.output.safeParse({
        ...createHistoryOutput({
          ...internalRecord,
          backendAccount: null,
          submissionAttempts: [],
          userId: "user-1",
          userEmail: "member@example.com",
        }),
        userOptions: [{ id: "user-1", email: "member@example.com" }],
      }).success
    ).toBe(false);
  });

  it("registers a human-only lazy request snapshot read", () => {
    const operation = getOperation("image.getAdminHistoryRequestSnapshot");
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
    expect(
      operation?.input.safeParse({ id: "video-1", kind: "video" }).success
    ).toBe(true);
    expect(
      operation?.input.safeParse({
        id: "video-1",
        kind: "video",
        userId: "forged-user",
      }).success
    ).toBe(false);
  });

  it("registers system-only projection verification and rebuild maintenance", () => {
    const operation = getOperation("image.maintainHistoryCountProjection");
    expect(operation).toMatchObject({
      access: { kind: "system" },
      agentExposure: "human-only",
      readOnly: false,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
      hasMaintenanceWrite: true,
    });
    expect(operation?.input.safeParse({ mode: "verify" }).success).toBe(true);
    expect(operation?.input.safeParse({ mode: "rebuild" }).success).toBe(true);
    expect(
      operation?.input.safeParse({ mode: "rebuild", userId: "forged" }).success
    ).toBe(false);
  });
});
