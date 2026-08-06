/**
 * API 密钥管理 UOL operations 的 DB-free 契约测试。
 *
 * 职责：锁定 session-only 权限、human-only 暴露、strict 输入、可恢复明文与
 * 安全摘要 DTO，并确保旧审核/纯中转写入口不再注册。
 * 使用方：API 密钥 Server Actions、Web UOL bindings 与 MCP 暴露边界回归门。
 * 关键依赖：Vitest、UOL invoke 网关和 external-api operation 定义。
 */
import { describe, expect, it } from "vitest";

import { OperationError } from "../errors";
import { invokeOperation } from "../invoke";
import type { Principal } from "../principal";
import { getOperation } from "../registry";
import {
  createKey,
  deleteKey,
  listKeys,
  revokeKey,
  updateKeyGroup,
  updateKeyQuota,
} from "./external-api";

const sessionPrincipal = {
  type: "user",
  userId: "user-1",
  role: "user",
} satisfies Principal;

const apiKeyPrincipal = {
  type: "apiKey",
  credentialKind: "external",
  userId: "user-1",
  apiKeyId: "key-1",
} satisfies Principal;

const systemPrincipal = {
  type: "system",
  reason: "contract-test",
} satisfies Principal;

const currentGroup = {
  id: "group-1",
  name: "Pro Group",
  enabled: false,
  selectable: false,
};

const keySummary = {
  id: "key-1",
  name: "Production",
  keyPrefix: "g2i_abc",
  lastFour: "wxyz",
  generationGroupId: "group-1",
  creditLimit: 100,
  creditsUsed: 12.5,
  lastUsedAt: new Date("2026-07-22T08:00:00.000Z"),
  isActive: true,
  createdAt: new Date("2026-07-21T08:00:00.000Z"),
  updatedAt: new Date("2026-07-22T08:00:00.000Z"),
  currentGroup,
};

const keyListItem = {
  ...keySummary,
  apiKey: "sk-secret",
};

const keyOperations = [
  listKeys,
  createKey,
  revokeKey,
  deleteKey,
  updateKeyGroup,
  updateKeyQuota,
];

/** 断言 Promise 以指定 UOL 错误码失败。 */
async function expectOperationError(
  promise: Promise<unknown>,
  code: OperationError["code"]
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe(code);
  }
}

describe("external API key operation metadata", () => {
  it("declares all six management operations as session-only and human-only", () => {
    for (const operation of keyOperations) {
      expect(operation.access).toEqual({ kind: "user" });
      expect(operation.agentExposure).toBe("human-only");
    }
  });

  it("rejects API Key and system principals before execution", async () => {
    await expectOperationError(
      invokeOperation("externalApi.listKeys", {}, apiKeyPrincipal),
      "unauthenticated"
    );
    await expectOperationError(
      invokeOperation("externalApi.listKeys", {}, systemPrincipal),
      "unauthenticated"
    );
    await expectOperationError(
      invokeOperation("externalApi.listKeys", {}, sessionPrincipal),
      "not_implemented"
    );
  });

  it("removes the legacy moderation and relay operations", () => {
    expect(getOperation("externalApi.updateKeyModeration")).toBeUndefined();
    expect(getOperation("externalApi.updateKeyRelay")).toBeUndefined();
  });
});

describe("external API key input schemas", () => {
  it("accepts only the settled create fields", () => {
    expect(
      createKey.input.safeParse({
        name: "Production",
        generationGroupId: "group-1",
        creditLimit: 100,
      }).success
    ).toBe(true);
    expect(
      createKey.input.safeParse({
        name: "Production",
        generationGroupId: null,
        creditLimit: null,
      }).success
    ).toBe(true);

    for (const legacyField of [
      { relayOnly: false },
      { relay_only: false },
      { moderationBlockRiskLevel: "high" },
      { moderation_block_risk_level: "high" },
    ]) {
      expect(
        createKey.input.safeParse({ name: "Production", ...legacyField })
          .success
      ).toBe(false);
    }
  });

  it("uses strict, lifecycle-specific mutation inputs", () => {
    expect(revokeKey.input.safeParse({ keyId: "key-1" }).success).toBe(true);
    expect(deleteKey.input.safeParse({ keyId: "key-1" }).success).toBe(true);
    expect(
      updateKeyGroup.input.safeParse({
        keyId: "key-1",
        generationGroupId: null,
      }).success
    ).toBe(true);
    expect(
      updateKeyQuota.input.safeParse({
        keyId: "key-1",
        creditLimit: null,
      }).success
    ).toBe(true);

    for (const operation of [
      revokeKey,
      deleteKey,
      updateKeyGroup,
      updateKeyQuota,
    ]) {
      expect(
        operation.input.safeParse({ keyId: "key-1", relayOnly: false }).success
      ).toBe(false);
    }
  });
});

describe("external API key output schemas", () => {
  it("只向本人列表返回可复制明文和可编辑分组候选", () => {
    expect(
      listKeys.output.safeParse({
        keys: [keyListItem, { ...keyListItem, apiKey: null }],
        editableGroups: [
          {
            id: "group-2",
            name: "Selectable Group",
            enabled: true,
            selectable: true,
          },
        ],
      }).success
    ).toBe(true);

    for (const legacyField of [
      { keyHash: "secret-hash" },
      { encryptedKey: "encrypted-secret" },
      { relayOnly: false },
      { moderationBlockRiskLevel: "high" },
    ]) {
      expect(
        listKeys.output.safeParse({
          keys: [{ ...keyListItem, ...legacyField }],
          editableGroups: [],
        }).success
      ).toBe(false);
    }
    expect(
      listKeys.output.safeParse({
        keys: [keySummary],
        editableGroups: [],
      }).success
    ).toBe(false);
  });

  it("创建返回明文，mutation 继续只返回安全摘要", () => {
    expect(
      createKey.output.safeParse({ apiKey: "sk-secret", key: keySummary })
        .success
    ).toBe(true);
    expect(revokeKey.output.safeParse(keySummary).success).toBe(true);
    expect(updateKeyGroup.output.safeParse(keySummary).success).toBe(true);
    expect(updateKeyQuota.output.safeParse(keySummary).success).toBe(true);
    expect(deleteKey.output.safeParse({ id: "key-1" }).success).toBe(true);
    expect(
      createKey.output.safeParse({ apiKey: "g2i_secret", key: keySummary })
        .success
    ).toBe(false);

    expect(
      listKeys.output.safeParse({
        keys: [{ ...keyListItem, keyHash: "secret-hash" }],
        editableGroups: [],
      }).success
    ).toBe(false);
  });
});
