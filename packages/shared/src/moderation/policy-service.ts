/**
 * 内容审核策略领域服务。
 *
 * 职责：直接读取数据库策略真相，执行管理员权限与目标角色校验，并在服务自持
 * 事务中原子提交策略和管理员审计。缓存只在事务提交后失效，失败时告警但不回滚。
 * 使用方：审核策略 UOL operations、管理员读模型与图像生成管线。
 * 生产 I/O 由 Go 执行；policy-contract、auth/roles 与注入式服务保留纯策略回归。
 */

import { z } from "zod";

import { type AppUserRole, canActOnTargetRole } from "../auth/roles";
import {
  CONTENT_MODERATION_BLOCK_RISK_LEVEL_SETTING_KEY,
  type ModerationBlockRiskLevel,
  moderationBlockRiskLevelSchema,
  moderationPolicyChangeReasonSchema,
  type ResolvedModerationPolicyValues,
  resolveModerationPolicyValues,
} from "./policy-contract";

export { CONTENT_MODERATION_BLOCK_RISK_LEVEL_SETTING_KEY } from "./policy-contract";

/** 全站策略写 operation 名，同时作为审计 action。 */
export const SET_GLOBAL_RISK_LEVEL_OPERATION =
  "moderation.setGlobalRiskLevel" as const;

/** 用户覆盖写 operation 名，同时作为审计 action。 */
export const SET_USER_RISK_LEVEL_OVERRIDE_OPERATION =
  "moderation.setUserRiskLevelOverride" as const;

/** 服务可返回的稳定领域错误码。 */
export type ModerationPolicyServiceErrorCode =
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "invariant_error";

/** 审核策略服务的可预期领域错误。 */
export class ModerationPolicyServiceError extends Error {
  /** 可由 UOL 稳定映射的错误码。 */
  readonly code: ModerationPolicyServiceErrorCode;

  /**
   * 创建一个不携带数据库内部细节的领域错误。
   *
   * @param code - 稳定错误码。
   * @param message - 可供上层映射的安全消息。
   */
  constructor(code: ModerationPolicyServiceErrorCode, message: string) {
    super(message);
    this.name = "ModerationPolicyServiceError";
    this.code = code;
  }
}

/** 发起策略写入的真实管理员身份。 */
export interface ModerationPolicyActor {
  userId: string;
  role: AppUserRole;
}

/** 加锁后读取的全站策略行。 */
export interface LockedGlobalPolicy {
  value: unknown;
  updatedAt: Date;
}

/** 加锁后读取的目标用户策略行。 */
export interface LockedUserPolicy {
  id: string;
  role: AppUserRole;
  userOverride: unknown;
  updatedAt: Date;
}

/** 用户与全站策略的一次强一致读取结果。 */
export interface UserPolicyReadRecord {
  globalDefault: unknown;
  user: Pick<LockedUserPolicy, "id" | "role" | "userOverride"> | null;
}

/** 管理员审计日志的事务内写入结构。 */
export interface AdminAuditLogInsert {
  id: string;
  adminUserId: string;
  targetUserId: string | null;
  action: string;
  reason: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  metadata: {
    requestId: string;
    operation: string;
    actorUserId: string;
    actorRole: AppUserRole;
    targetUserId: string | null;
    targetRole: AppUserRole | null;
  };
  createdAt: Date;
}

/** 审核策略写事务所需的最小数据库端口。 */
export interface ModerationPolicyTransaction {
  lockGlobalPolicy: () => Promise<LockedGlobalPolicy | null>;
  updateGlobalPolicy: (input: {
    level: ModerationBlockRiskLevel;
    actorUserId: string;
    updatedAt: Date;
  }) => Promise<void>;
  lockUserPolicy: (userId: string) => Promise<LockedUserPolicy | null>;
  updateUserOverride: (input: {
    userId: string;
    level: ModerationBlockRiskLevel | null;
    updatedAt: Date;
  }) => Promise<void>;
  readGlobalPolicy: () => Promise<LockedGlobalPolicy | null>;
  insertAuditLog: (input: AdminAuditLogInsert) => Promise<void>;
}

/** 审核策略服务的可替换仓储端口。 */
export interface ModerationPolicyRepository {
  readGlobalPolicy: () => Promise<LockedGlobalPolicy | null>;
  readUserPolicy: (userId: string) => Promise<UserPolicyReadRecord>;
  transaction: <T>(
    work: (tx: ModerationPolicyTransaction) => Promise<T>
  ) => Promise<T>;
}

/** 全站策略写入参数。 */
export interface SetGlobalRiskLevelInput {
  actor: ModerationPolicyActor;
  level: ModerationBlockRiskLevel;
  reason: string;
  requestId: string;
}

/** 用户审核覆盖写入参数，`null` 表示继承全站值。 */
export interface SetUserRiskLevelOverrideInput {
  actor: ModerationPolicyActor;
  userId: string;
  level: ModerationBlockRiskLevel | null;
  reason: string;
  requestId: string;
}

/** 全站策略写入结果。 */
export interface SetGlobalRiskLevelResult {
  changed: boolean;
  before: unknown;
  after: ModerationBlockRiskLevel;
  auditLogId: string | null;
  updatedAt: Date;
}

/** 用户覆盖写入结果。 */
export interface SetUserRiskLevelOverrideResult {
  changed: boolean;
  before: unknown;
  after: ModerationBlockRiskLevel | null;
  effectiveLevel: ModerationBlockRiskLevel;
  source: ResolvedModerationPolicyValues["source"];
  auditLogId: string | null;
  updatedAt: Date;
}

/** 服务的注入依赖，测试可替换数据库、时间、ID、缓存与告警。 */
export interface ModerationPolicyServiceDependencies {
  repository: ModerationPolicyRepository;
  invalidateSystemSettingsCache: () => Promise<void>;
  warn: (message: string, data: Record<string, unknown>) => void;
  now: () => Date;
  createAuditId: () => string;
}

/** 审核策略服务公开接口。 */
export interface ModerationPolicyService {
  getGlobalPolicy: () => Promise<ResolvedModerationPolicyValues>;
  getUserPolicy: (userId: string) => Promise<ResolvedModerationPolicyValues>;
  resolveEffectivePolicy: (
    userId: string
  ) => Promise<ResolvedModerationPolicyValues>;
  setGlobalRiskLevel: (
    input: SetGlobalRiskLevelInput
  ) => Promise<SetGlobalRiskLevelResult>;
  setUserRiskLevelOverride: (
    input: SetUserRiskLevelOverrideInput
  ) => Promise<SetUserRiskLevelOverrideResult>;
}

const requestIdSchema = z.string().trim().min(1).max(200);
const nullableRiskLevelSchema = moderationBlockRiskLevelSchema.nullable();

/** 将未知审核档位校验为服务可写值。 */
function parseRiskLevel(value: unknown): ModerationBlockRiskLevel {
  const parsed = moderationBlockRiskLevelSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ModerationPolicyServiceError(
    "validation_error",
    "Invalid moderation risk level"
  );
}

/** 将未知用户覆盖校验为合法档位或继承状态。 */
function parseNullableRiskLevel(
  value: unknown
): ModerationBlockRiskLevel | null {
  const parsed = nullableRiskLevelSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ModerationPolicyServiceError(
    "validation_error",
    "Invalid moderation risk level override"
  );
}

/** 校验并归一管理员填写的变更原因。 */
function parseChangeReason(value: unknown): string {
  const parsed = moderationPolicyChangeReasonSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ModerationPolicyServiceError(
    "validation_error",
    "Change reason must contain 1 to 300 characters"
  );
}

/** 校验请求标识，防止空值进入持久审计。 */
function parseRequestId(value: unknown): string {
  const parsed = requestIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ModerationPolicyServiceError(
    "validation_error",
    "A valid request ID is required"
  );
}

/** 对实际使用 fallback_high 的读取写入结构化、无敏感值告警。 */
function warnFallbackHigh(
  warn: ModerationPolicyServiceDependencies["warn"],
  result: ResolvedModerationPolicyValues,
  userId?: string
): void {
  if (result.source !== "fallback_high") return;
  warn("内容审核策略回退到 high", {
    event: "moderation_policy_fallback_high",
    settingKey: CONTENT_MODERATION_BLOCK_RISK_LEVEL_SETTING_KEY,
    ...(userId ? { userId } : {}),
  });
}

/** 在提交后执行缓存失效；失败仅告警，数据库提交仍是最终结果。 */
async function invalidateCacheAfterCommit(
  dependencies: ModerationPolicyServiceDependencies,
  operation: string
): Promise<void> {
  try {
    await dependencies.invalidateSystemSettingsCache();
  } catch (error) {
    dependencies.warn("审核策略已提交，但系统设置缓存失效失败", {
      event: "moderation_policy_cache_invalidation_failed",
      operation,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

/** 构造全站策略审计，避免把请求输入整体写入日志。 */
function createGlobalAudit(input: {
  id: string;
  actor: ModerationPolicyActor;
  requestId: string;
  reason: string;
  before: unknown;
  after: ModerationBlockRiskLevel;
  createdAt: Date;
}): AdminAuditLogInsert {
  return {
    id: input.id,
    adminUserId: input.actor.userId,
    targetUserId: null,
    action: SET_GLOBAL_RISK_LEVEL_OPERATION,
    reason: input.reason,
    before: { level: input.before },
    after: { level: input.after },
    metadata: {
      requestId: input.requestId,
      operation: SET_GLOBAL_RISK_LEVEL_OPERATION,
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      targetUserId: null,
      targetRole: null,
    },
    createdAt: input.createdAt,
  };
}

/** 构造用户覆盖审计，固定记录目标角色与请求标识。 */
function createUserAudit(input: {
  id: string;
  actor: ModerationPolicyActor;
  target: LockedUserPolicy;
  requestId: string;
  reason: string;
  before: unknown;
  after: ModerationBlockRiskLevel | null;
  createdAt: Date;
}): AdminAuditLogInsert {
  return {
    id: input.id,
    adminUserId: input.actor.userId,
    targetUserId: input.target.id,
    action: SET_USER_RISK_LEVEL_OVERRIDE_OPERATION,
    reason: input.reason,
    before: { level: input.before },
    after: { level: input.after },
    metadata: {
      requestId: input.requestId,
      operation: SET_USER_RISK_LEVEL_OVERRIDE_OPERATION,
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      targetUserId: input.target.id,
      targetRole: input.target.role,
    },
    createdAt: input.createdAt,
  };
}

/**
 * 创建审核策略服务。
 *
 * @param dependencies - 数据库、缓存、时钟、ID 与告警端口。
 * @returns 传输无关的审核策略读取和写入接口。
 */
export function createModerationPolicyService(
  dependencies: ModerationPolicyServiceDependencies
): ModerationPolicyService {
  /** 读取并归一全站策略，不把数据库异常降级成业务回退。 */
  async function getGlobalPolicy(): Promise<ResolvedModerationPolicyValues> {
    const record = await dependencies.repository.readGlobalPolicy();
    const result = resolveModerationPolicyValues({
      globalDefault: record?.value,
      userOverride: null,
    });
    warnFallbackHigh(dependencies.warn, result);
    return result;
  }

  /** 读取目标用户策略；用户不存在时返回稳定领域错误。 */
  async function resolveEffectivePolicy(
    userId: string
  ): Promise<ResolvedModerationPolicyValues> {
    const record = await dependencies.repository.readUserPolicy(userId);
    if (!record.user) {
      throw new ModerationPolicyServiceError("not_found", "User not found");
    }
    const result = resolveModerationPolicyValues({
      globalDefault: record.globalDefault,
      userOverride: record.user.userOverride,
    });
    warnFallbackHigh(dependencies.warn, result, userId);
    return result;
  }

  /** 仅允许 super_admin 原子修改全站值和审计。 */
  async function setGlobalRiskLevel(
    input: SetGlobalRiskLevelInput
  ): Promise<SetGlobalRiskLevelResult> {
    if (input.actor.role !== "super_admin") {
      throw new ModerationPolicyServiceError(
        "forbidden",
        "Only super administrators can change the global moderation policy"
      );
    }
    const level = parseRiskLevel(input.level);
    const reason = parseChangeReason(input.reason);
    const requestId = parseRequestId(input.requestId);

    const result = await dependencies.repository.transaction(async (tx) => {
      const before = await tx.lockGlobalPolicy();
      if (!before) {
        throw new ModerationPolicyServiceError(
          "invariant_error",
          "Global moderation policy row is missing"
        );
      }
      if (before.value === level) {
        return {
          changed: false,
          before: before.value,
          after: level,
          auditLogId: null,
          updatedAt: before.updatedAt,
        } satisfies SetGlobalRiskLevelResult;
      }

      const updatedAt = dependencies.now();
      const auditLogId = dependencies.createAuditId();
      await tx.updateGlobalPolicy({
        level,
        actorUserId: input.actor.userId,
        updatedAt,
      });
      await tx.insertAuditLog(
        createGlobalAudit({
          id: auditLogId,
          actor: input.actor,
          requestId,
          reason,
          before: before.value,
          after: level,
          createdAt: updatedAt,
        })
      );
      return {
        changed: true,
        before: before.value,
        after: level,
        auditLogId,
        updatedAt,
      } satisfies SetGlobalRiskLevelResult;
    });

    if (result.changed) {
      await invalidateCacheAfterCommit(
        dependencies,
        SET_GLOBAL_RISK_LEVEL_OPERATION
      );
    }
    return result;
  }

  /** 允许 admin 管理更低角色、super_admin 管理任意目标。 */
  async function setUserRiskLevelOverride(
    input: SetUserRiskLevelOverrideInput
  ): Promise<SetUserRiskLevelOverrideResult> {
    if (input.actor.role !== "admin" && input.actor.role !== "super_admin") {
      throw new ModerationPolicyServiceError(
        "forbidden",
        "Administrator access is required"
      );
    }
    const level = parseNullableRiskLevel(input.level);
    const reason = parseChangeReason(input.reason);
    const requestId = parseRequestId(input.requestId);

    const result = await dependencies.repository.transaction(async (tx) => {
      const target = await tx.lockUserPolicy(input.userId);
      if (!target) {
        throw new ModerationPolicyServiceError("not_found", "User not found");
      }
      if (
        input.actor.role !== "super_admin" &&
        (input.actor.userId === target.id ||
          !canActOnTargetRole(input.actor.role, target.role))
      ) {
        throw new ModerationPolicyServiceError(
          "forbidden",
          "Cannot change moderation policy for this target role"
        );
      }

      const globalPolicy = await tx.readGlobalPolicy();
      const resolved = resolveModerationPolicyValues({
        globalDefault: globalPolicy?.value,
        userOverride: level,
      });
      if (target.userOverride === level) {
        return {
          changed: false,
          before: target.userOverride,
          after: level,
          effectiveLevel: resolved.effectiveLevel,
          source: resolved.source,
          auditLogId: null,
          updatedAt: target.updatedAt,
        } satisfies SetUserRiskLevelOverrideResult;
      }

      const updatedAt = dependencies.now();
      const auditLogId = dependencies.createAuditId();
      await tx.updateUserOverride({
        userId: target.id,
        level,
        updatedAt,
      });
      await tx.insertAuditLog(
        createUserAudit({
          id: auditLogId,
          actor: input.actor,
          target,
          requestId,
          reason,
          before: target.userOverride,
          after: level,
          createdAt: updatedAt,
        })
      );
      return {
        changed: true,
        before: target.userOverride,
        after: level,
        effectiveLevel: resolved.effectiveLevel,
        source: resolved.source,
        auditLogId,
        updatedAt,
      } satisfies SetUserRiskLevelOverrideResult;
    });

    if (result.changed) {
      await invalidateCacheAfterCommit(
        dependencies,
        SET_USER_RISK_LEVEL_OVERRIDE_OPERATION
      );
    }
    warnFallbackHigh(
      dependencies.warn,
      {
        globalDefault: result.effectiveLevel,
        userOverride: result.after,
        effectiveLevel: result.effectiveLevel,
        source: result.source,
      },
      input.userId
    );
    return result;
  }

  return {
    getGlobalPolicy,
    getUserPolicy: resolveEffectivePolicy,
    resolveEffectivePolicy,
    setGlobalRiskLevel,
    setUserRiskLevelOverride,
  };
}

/** Production policy reads and audited writes execute at the Go boundary. */
export const moderationPolicyService: ModerationPolicyService = {
  async getGlobalPolicy() {
    const { requestGoBackendJson } = await import("../http/go-backend");
    const raw = await requestGoBackendJson<{ policy: ResolvedModerationPolicyValues }>("/api/system-settings/moderation-policy");
    return raw.policy;
  },
  async getUserPolicy(userId) {
    const { requestGoBackendJson } = await import("../http/go-backend");
    return requestGoBackendJson<ResolvedModerationPolicyValues>(`/api/moderation/users/${encodeURIComponent(userId)}/policy`);
  },
  async resolveEffectivePolicy(userId) {
    const { requestGoBackendJson } = await import("../http/go-backend");
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) throw new ModerationPolicyServiceError("invariant_error", "审核策略服务未配置");
    return requestGoBackendJson<ResolvedModerationPolicyValues>(`/api/moderation/users/${encodeURIComponent(userId)}/policy`, {
      headers: { authorization: `Bearer ${secret}` },
    });
  },
  async setGlobalRiskLevel(input) {
    const { requestGoBackendJson } = await import("../http/go-backend");
    const raw = await requestGoBackendJson<{
      changed: boolean; previousLevel: unknown; level: ModerationBlockRiskLevel;
      auditLogId: string | null; updatedAt: string;
    }>("/api/system-settings/moderation-policy", {
      method: "PUT", headers: { "X-Request-ID": input.requestId },
      body: JSON.stringify({ level: input.level, reason: input.reason }),
    });
    return { changed: raw.changed, before: raw.previousLevel, after: raw.level,
      auditLogId: raw.auditLogId, updatedAt: new Date(raw.updatedAt) };
  },
  async setUserRiskLevelOverride(input) {
    const { requestGoBackendJson } = await import("../http/go-backend");
    const raw = await requestGoBackendJson<Omit<SetUserRiskLevelOverrideResult, "updatedAt"> & { updatedAt: string }>(
      `/api/moderation/users/${encodeURIComponent(input.userId)}/policy`, {
        method: "POST", headers: { "X-Request-ID": input.requestId },
        body: JSON.stringify({ userId: input.userId, level: input.level, reason: input.reason }),
      }
    );
    return { ...raw, updatedAt: new Date(raw.updatedAt) };
  },
};

/** 直接读取全站审核策略。 */
export function getGlobalModerationPolicy() {
  return moderationPolicyService.getGlobalPolicy();
}

/** 读取指定用户的管理员策略视图。 */
export function getUserModerationPolicy(userId: string) {
  return moderationPolicyService.getUserPolicy(userId);
}

/** 为生成管线解析指定用户的唯一生效审核级别。 */
export function resolveEffectiveModerationPolicy(userId: string) {
  return moderationPolicyService.resolveEffectivePolicy(userId);
}

/** 通过默认事务仓储修改全站审核级别。 */
export function setGlobalModerationRiskLevel(input: SetGlobalRiskLevelInput) {
  return moderationPolicyService.setGlobalRiskLevel(input);
}

/** 通过默认事务仓储设置或清除用户审核覆盖。 */
export function setUserModerationRiskLevelOverride(
  input: SetUserRiskLevelOverrideInput
) {
  return moderationPolicyService.setUserRiskLevelOverride(input);
}
