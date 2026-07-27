/**
 * 审核策略 UOL operations 的 DB-free 契约测试。
 *
 * 职责：验证角色权限、human-only 暴露边界、strict 输入、真实管理员身份传递、
 * requestId 审计关联和领域错误映射。
 * 使用方：管理员 Server Actions、生成管线与 MCP 工具工厂的接口回归门。
 * 关键依赖：Vitest、UOL invoke 网关；policy service 与 legacy moderation 均使用 mock。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { moderateContent as moderateContentFn } from "../../moderation/index";
import type { ResolvedModerationPolicyValues } from "../../moderation/policy-contract";
import {
  ModerationPolicyServiceError,
  moderationPolicyService,
  type SetGlobalRiskLevelResult,
  type SetUserRiskLevelOverrideResult,
} from "../../moderation/policy-service";
import { OperationError } from "../errors";
import { invokeOperation } from "../invoke";
import type { Principal } from "../principal";
import {
  getGlobalRiskPolicy,
  getUserRiskPolicy,
  moderateContent as moderateContentOperation,
  proxyModerate,
  resolveEffectiveRiskLevel,
  setGlobalRiskLevel,
  setUserRiskLevelOverride,
} from "./moderation";

vi.mock("../../moderation/index", () => ({
  getConfiguredModerationProviders: vi.fn(async () => []),
  isContentModerationEnabled: vi.fn(async () => true),
  moderateContent: vi.fn(async () => ({ decision: "allow" })),
}));

vi.mock("../../moderation/policy-service", () => {
  type ServiceErrorCode =
    | "forbidden"
    | "not_found"
    | "validation_error"
    | "invariant_error";

  class TestModerationPolicyServiceError extends Error {
    readonly code: ServiceErrorCode;

    /** 创建供 operation 错误映射测试使用的领域错误。 */
    constructor(code: ServiceErrorCode, message: string) {
      super(message);
      this.name = "ModerationPolicyServiceError";
      this.code = code;
    }
  }

  return {
    ModerationPolicyServiceError: TestModerationPolicyServiceError,
    moderationPolicyService: {
      getGlobalPolicy: vi.fn(),
      getUserPolicy: vi.fn(),
      resolveEffectivePolicy: vi.fn(),
      setGlobalRiskLevel: vi.fn(),
      setUserRiskLevelOverride: vi.fn(),
    },
  };
});

const principals = {
  user: { type: "user", userId: "user-1", role: "user" },
  observer: {
    type: "user",
    userId: "observer-1",
    role: "observer_admin",
  },
  admin: { type: "user", userId: "admin-1", role: "admin" },
  superAdmin: {
    type: "user",
    userId: "super-1",
    role: "super_admin",
  },
  apiKey: {
    type: "apiKey",
    credentialKind: "external",
    userId: "user-1",
    apiKeyId: "key-1",
    plan: "pro",
  },
  system: { type: "system", reason: "generation" },
} satisfies Record<string, Principal>;

const globalPolicy: ResolvedModerationPolicyValues = {
  globalDefault: "high",
  userOverride: null,
  effectiveLevel: "high",
  source: "global",
};

const userPolicy: ResolvedModerationPolicyValues = {
  globalDefault: "low",
  userOverride: "medium",
  effectiveLevel: "medium",
  source: "user_override",
};

const updatedAt = new Date("2026-07-23T00:00:00.000Z");

const globalWriteResult: SetGlobalRiskLevelResult = {
  changed: true,
  before: "high",
  after: "low",
  auditLogId: "audit-global",
  updatedAt,
};

const userWriteResult: SetUserRiskLevelOverrideResult = {
  changed: true,
  before: null,
  after: "medium",
  effectiveLevel: "medium",
  source: "user_override",
  auditLogId: "audit-user",
  updatedAt,
};

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

beforeEach(() => {
  vi.mocked(moderateContentFn).mockClear();
  vi.mocked(moderationPolicyService.getGlobalPolicy).mockReset();
  vi.mocked(moderationPolicyService.getUserPolicy).mockReset();
  vi.mocked(moderationPolicyService.resolveEffectivePolicy).mockReset();
  vi.mocked(moderationPolicyService.setGlobalRiskLevel).mockReset();
  vi.mocked(moderationPolicyService.setUserRiskLevelOverride).mockReset();

  vi.mocked(moderationPolicyService.getGlobalPolicy).mockResolvedValue(
    globalPolicy
  );
  vi.mocked(moderationPolicyService.getUserPolicy).mockResolvedValue(
    userPolicy
  );
  vi.mocked(moderationPolicyService.resolveEffectivePolicy).mockResolvedValue(
    userPolicy
  );
  vi.mocked(moderationPolicyService.setGlobalRiskLevel).mockResolvedValue(
    globalWriteResult
  );
  vi.mocked(moderationPolicyService.setUserRiskLevelOverride).mockResolvedValue(
    userWriteResult
  );
});

describe("moderation execution input schemas", () => {
  it("accepts only a legal trusted effective level", () => {
    const validInput = { prompt: "hi", effectiveBlockRiskLevel: "medium" };
    expect(moderateContentOperation.input.safeParse(validInput).success).toBe(
      true
    );
    expect(proxyModerate.input.safeParse(validInput).success).toBe(true);

    for (const operation of [moderateContentOperation, proxyModerate]) {
      expect(operation.input.safeParse({ prompt: "hi" }).success).toBe(false);
      expect(
        operation.input.safeParse({
          prompt: "hi",
          effectiveBlockRiskLevel: "invalid",
        }).success
      ).toBe(false);
    }
  });

  it("strictly rejects legacy plan and user-level governance fields", () => {
    for (const operation of [moderateContentOperation, proxyModerate]) {
      expect(
        operation.input.safeParse({
          prompt: "hi",
          effectiveBlockRiskLevel: "high",
          userPlan: "free",
        }).success
      ).toBe(false);
      expect(
        operation.input.safeParse({
          prompt: "hi",
          effectiveBlockRiskLevel: "high",
          userModerationBlockRiskLevel: "low",
        }).success
      ).toBe(false);
    }
  });

  it("passes the trusted effective level to the moderation orchestrator", async () => {
    await expect(
      invokeOperation(
        "moderation.moderateContent",
        { prompt: "hi", effectiveBlockRiskLevel: "medium" },
        principals.system
      )
    ).resolves.toEqual({ decision: "allow" });

    expect(moderateContentFn).toHaveBeenCalledWith({
      prompt: "hi",
      effectiveBlockRiskLevel: "medium",
    });
  });
});

describe("moderation policy operation metadata", () => {
  it("declares the settled role matrix and human-only exposure", () => {
    expect(getGlobalRiskPolicy.access).toEqual({
      kind: "roles",
      roles: ["super_admin"],
    });
    expect(setGlobalRiskLevel.access).toEqual({
      kind: "roles",
      roles: ["super_admin"],
    });
    expect(getUserRiskPolicy.access).toEqual({
      kind: "roles",
      roles: ["observer_admin", "admin", "super_admin"],
    });
    expect(setUserRiskLevelOverride.access).toEqual({
      kind: "roles",
      roles: ["admin", "super_admin"],
    });
    expect(resolveEffectiveRiskLevel.access).toEqual({ kind: "system" });

    for (const operation of [
      getGlobalRiskPolicy,
      setGlobalRiskLevel,
      getUserRiskPolicy,
      setUserRiskLevelOverride,
    ]) {
      expect(operation.agentExposure).toBe("human-only");
    }
    expect(resolveEffectiveRiskLevel.agentExposure).toBeUndefined();

    expect(getGlobalRiskPolicy.output.safeParse(globalPolicy).success).toBe(
      true
    );
    expect(setGlobalRiskLevel.output.safeParse(globalWriteResult).success).toBe(
      true
    );
    expect(getUserRiskPolicy.output.safeParse(userPolicy).success).toBe(true);
    expect(
      setUserRiskLevelOverride.output.safeParse(userWriteResult).success
    ).toBe(true);
  });
});

describe("moderation policy input schemas", () => {
  it("uses strict input objects and never accepts a client actor", () => {
    expect(getGlobalRiskPolicy.input.safeParse({ extra: true }).success).toBe(
      false
    );
    expect(
      setGlobalRiskLevel.input.safeParse({
        level: "low",
        reason: "policy change",
        actorUserId: "forged",
      }).success
    ).toBe(false);
    expect(
      getUserRiskPolicy.input.safeParse({
        userId: "target-1",
        actorRole: "super_admin",
      }).success
    ).toBe(false);
    expect(
      resolveEffectiveRiskLevel.input.safeParse({
        userId: "target-1",
        extra: true,
      }).success
    ).toBe(false);
    expect(
      setUserRiskLevelOverride.input.safeParse({
        userId: "target-1",
        level: null,
        reason: "inherit",
        actorUserId: "forged",
      }).success
    ).toBe(false);
  });

  it("validates levels and the trimmed 1 to 300 character reason", () => {
    expect(
      setGlobalRiskLevel.input.safeParse({ level: "low", reason: " why " }).data
    ).toEqual({ level: "low", reason: "why" });
    expect(
      setGlobalRiskLevel.input.safeParse({ level: "critical", reason: "x" })
        .success
    ).toBe(false);
    expect(
      setGlobalRiskLevel.input.safeParse({ level: "low", reason: "   " })
        .success
    ).toBe(false);
    expect(
      setGlobalRiskLevel.input.safeParse({
        level: "low",
        reason: "x".repeat(301),
      }).success
    ).toBe(false);
    expect(
      setUserRiskLevelOverride.input.safeParse({
        userId: "target-1",
        level: null,
        reason: "inherit global",
      }).success
    ).toBe(true);
  });
});

describe("moderation policy access and service delegation", () => {
  it("allows only super_admin to read and write global policy", async () => {
    await expect(
      invokeOperation(
        "moderation.getGlobalRiskPolicy",
        {},
        principals.superAdmin
      )
    ).resolves.toEqual(globalPolicy);

    await expectOperationError(
      invokeOperation("moderation.getGlobalRiskPolicy", {}, principals.admin),
      "forbidden"
    );
    await expectOperationError(
      invokeOperation(
        "moderation.setGlobalRiskLevel",
        { level: "low", reason: "change" },
        principals.system
      ),
      "forbidden"
    );
  });

  it("allows observer reads but reserves user writes for admin roles", async () => {
    await expect(
      invokeOperation(
        "moderation.getUserRiskPolicy",
        { userId: "target-1" },
        principals.observer
      )
    ).resolves.toEqual(userPolicy);
    expect(moderationPolicyService.getUserPolicy).toHaveBeenCalledWith(
      "target-1"
    );

    await expectOperationError(
      invokeOperation(
        "moderation.setUserRiskLevelOverride",
        { userId: "target-1", level: null, reason: "inherit" },
        principals.observer
      ),
      "forbidden"
    );
    await expectOperationError(
      invokeOperation(
        "moderation.getUserRiskPolicy",
        { userId: "target-1" },
        principals.apiKey
      ),
      "forbidden"
    );
  });

  it("passes the authenticated actor and request ID to global writes", async () => {
    await expect(
      invokeOperation(
        "moderation.setGlobalRiskLevel",
        { level: "low", reason: "  incident response  " },
        principals.superAdmin,
        { requestId: "request-global" }
      )
    ).resolves.toEqual(globalWriteResult);

    expect(moderationPolicyService.setGlobalRiskLevel).toHaveBeenCalledWith({
      actor: { userId: "super-1", role: "super_admin" },
      level: "low",
      reason: "incident response",
      requestId: "request-global",
    });
  });

  it("passes the authenticated actor, target and nullable level to user writes", async () => {
    await expect(
      invokeOperation(
        "moderation.setUserRiskLevelOverride",
        { userId: "target-1", level: null, reason: " inherit global " },
        principals.admin,
        { requestId: "request-user" }
      )
    ).resolves.toEqual(userWriteResult);

    expect(
      moderationPolicyService.setUserRiskLevelOverride
    ).toHaveBeenCalledWith({
      actor: { userId: "admin-1", role: "admin" },
      userId: "target-1",
      level: null,
      reason: "inherit global",
      requestId: "request-user",
    });
  });

  it("keeps the effective resolver system-only", async () => {
    await expect(
      invokeOperation(
        "moderation.resolveEffectiveRiskLevel",
        { userId: "target-1" },
        principals.system
      )
    ).resolves.toEqual(userPolicy);
    expect(moderationPolicyService.resolveEffectivePolicy).toHaveBeenCalledWith(
      "target-1"
    );

    await expectOperationError(
      invokeOperation(
        "moderation.resolveEffectiveRiskLevel",
        { userId: "target-1" },
        principals.superAdmin
      ),
      "forbidden"
    );
  });

  it("maps stable policy service errors to OperationError", async () => {
    vi.mocked(moderationPolicyService.getUserPolicy).mockRejectedValueOnce(
      new ModerationPolicyServiceError("not_found", "User not found")
    );

    await expectOperationError(
      invokeOperation(
        "moderation.getUserRiskPolicy",
        { userId: "missing" },
        principals.admin
      ),
      "not_found"
    );
  });
});
