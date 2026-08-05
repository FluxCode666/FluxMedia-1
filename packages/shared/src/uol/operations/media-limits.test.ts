/**
 * 媒体限制 UOL operations 的 DB-free 契约测试。
 *
 * 验证用户/API Key 同策略、管理员 human-only 写入、归属保护和并发超限 429 映射。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getForUser: vi.fn(),
  setUserConcurrencyOverride: vi.fn(),
}));

vi.mock("../../image-generation/media-limit-service", () => {
  class TestMediaLimitServiceError extends Error {
    readonly code:
      | "forbidden"
      | "not_found"
      | "validation_error"
      | "invariant_error";

    constructor(
      code: "forbidden" | "not_found" | "validation_error" | "invariant_error",
      message: string
    ) {
      super(message);
      this.name = "MediaLimitServiceError";
      this.code = code;
    }
  }
  return {
    MediaLimitServiceError: TestMediaLimitServiceError,
    mediaLimitService: mocks,
  };
});

import { createConcurrencyLimitExceededError, OperationError } from "../errors";
import { invokeOperation } from "../invoke";
import type { Principal } from "../principal";
import {
  mediaLimitsGetEffective,
  mediaLimitsSetUserConcurrencyOverride,
} from "./media-limits";

const policy = {
  defaultUserConcurrency: 20,
  maxFileSizeMb: 5,
  maxUploadSizeMb: 75,
  maxEditReferenceImages: 16,
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxUploadSizeBytes: 75 * 1024 * 1024,
  limit: 20,
  override: null,
  effectiveSource: "system_default" as const,
  scope: "user" as const,
};

const principals = {
  user: { type: "user", userId: "member", role: "user" },
  admin: { type: "user", userId: "admin", role: "admin" },
  observer: {
    type: "user",
    userId: "observer",
    role: "observer_admin",
  },
  apiKey: {
    type: "apiKey",
    credentialKind: "external",
    userId: "member",
    apiKeyId: "key-1",
    plan: "free",
  },
  system: { type: "system", reason: "generation" },
} satisfies Record<string, Principal>;

beforeEach(() => {
  mocks.getForUser.mockReset();
  mocks.setUserConcurrencyOverride.mockReset();
  mocks.getForUser.mockResolvedValue(policy);
  mocks.setUserConcurrencyOverride.mockResolvedValue({
    changed: true,
    before: null,
    after: 40,
    effectiveConcurrency: 40,
    effectiveSource: "user_override",
    auditLogId: "audit-1",
    updatedAt: new Date("2026-08-05T00:00:00Z"),
  });
});

describe("media limit UOL", () => {
  it("用户和 API Key 读取同一用户时得到相同无套餐策略", async () => {
    await expect(
      invokeOperation("mediaLimits.getEffective", {}, principals.user)
    ).resolves.toEqual(policy);
    await expect(
      invokeOperation("mediaLimits.getEffective", {}, principals.apiKey)
    ).resolves.toEqual(policy);

    expect(mocks.getForUser).toHaveBeenNthCalledWith(1, "member");
    expect(mocks.getForUser).toHaveBeenNthCalledWith(2, "member");
    expect(policy).not.toHaveProperty("plan");
  });

  it("普通用户和 API Key 不能指定其他用户", async () => {
    for (const principal of [principals.user, principals.apiKey]) {
      await expect(
        invokeOperation(
          "mediaLimits.getEffective",
          { userId: "other" },
          principal
        )
      ).rejects.toMatchObject({ code: "ownership_violation" });
    }
    expect(mocks.getForUser).not.toHaveBeenCalled();
  });

  it("system 必须显式提供目标用户", async () => {
    await expect(
      invokeOperation("mediaLimits.getEffective", {}, principals.system)
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      invokeOperation(
        "mediaLimits.getEffective",
        { userId: "member" },
        principals.system
      )
    ).resolves.toEqual(policy);
  });

  it("管理员写 operation 传递真实身份和 requestId", async () => {
    const result = await invokeOperation(
      "mediaLimits.setUserConcurrencyOverride",
      { userId: "member", override: 40, reason: "容量调整" },
      principals.admin,
      { requestId: "request-1" }
    );

    expect(result).toMatchObject({ after: 40, effectiveConcurrency: 40 });
    expect(mocks.setUserConcurrencyOverride).toHaveBeenCalledWith({
      actor: { userId: "admin", role: "admin" },
      userId: "member",
      override: 40,
      reason: "容量调整",
      requestId: "request-1",
    });
    expect(mediaLimitsSetUserConcurrencyOverride.agentExposure).toBe(
      "human-only"
    );
  });

  it("观察管理员不能写入且输入严格拒绝额外字段", async () => {
    await expect(
      invokeOperation(
        "mediaLimits.setUserConcurrencyOverride",
        { userId: "member", override: 40, reason: "容量调整" },
        principals.observer
      )
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      mediaLimitsSetUserConcurrencyOverride.input.safeParse({
        userId: "member",
        override: 40,
        reason: "容量调整",
        plan: "enterprise",
      }).success
    ).toBe(false);
  });

  it("输出契约固定四项设置和生效来源", () => {
    expect(mediaLimitsGetEffective.output.safeParse(policy).success).toBe(true);
    expect(
      mediaLimitsGetEffective.output.safeParse({ ...policy, plan: "free" })
        .success
    ).toBe(false);
  });

  it("并发超限错误默认映射 429 且只包含安全 details", () => {
    const error = createConcurrencyLimitExceededError({
      limit: 20,
      effectiveSource: "system_default",
    });
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({
      code: "concurrency_limit_exceeded",
      httpStatus: 429,
      details: {
        limit: 20,
        effectiveSource: "system_default",
        scope: "user",
      },
    });
    expect(JSON.stringify(error.details)).not.toMatch(
      /redis|token|prompt|key/i
    );
  });
});
