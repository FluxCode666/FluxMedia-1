/**
 * 媒体限制运行时服务。
 *
 * 职责：读取系统媒体参数、解析用户并发覆盖，并为管理员提供带角色护栏和审计的
 * 原子写入。所有入口只依赖本服务返回的生效策略，不直接读取套餐或用户表字段。
 * 生产读写由 Go 执行；注入式服务保留策略与权限语义回归测试。
 */


import {
  type AppUserRole,
  canActOnTargetRole,
} from "../auth/roles";
import {
  type EffectiveUserConcurrency,
  MEDIA_LIMIT_DEFAULTS,
  MEDIA_LIMIT_HARD_MAX,
  type MediaLimitPolicy,
  parseMediaLimitValue,
  resolveEffectiveUserConcurrency,
  resolveMediaLimitPolicy,
} from "./media-limit-policy";

export type MediaLimitServiceErrorCode =
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "invariant_error";

export class MediaLimitServiceError extends Error {
  readonly code: MediaLimitServiceErrorCode;

  /** 创建供 UOL 边界稳定映射的媒体限制服务错误。 */
  constructor(code: MediaLimitServiceErrorCode, message: string) {
    super(message);
    this.name = "MediaLimitServiceError";
    this.code = code;
  }
}

export interface MediaLimitActor {
  userId: string;
  role: AppUserRole;
}

export interface LockedUserConcurrency {
  id: string;
  role: AppUserRole;
  override: unknown;
  updatedAt: Date;
}

export interface MediaLimitAuditLogInsert {
  id: string;
  adminUserId: string;
  targetUserId: string;
  action: string;
  reason: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface MediaLimitTransaction {
  lockUserConcurrency: (
    userId: string
  ) => Promise<LockedUserConcurrency | null>;
  updateUserConcurrency: (input: {
    userId: string;
    override: number | null;
    updatedAt: Date;
  }) => Promise<void>;
  insertAuditLog: (input: MediaLimitAuditLogInsert) => Promise<void>;
}

export interface MediaLimitRepository {
  readUserConcurrency: (
    userId: string
  ) => Promise<LockedUserConcurrency | null>;
  transaction: <T>(
    work: (tx: MediaLimitTransaction) => Promise<T>
  ) => Promise<T>;
}

export type MediaLimitsForUser = MediaLimitPolicy & EffectiveUserConcurrency;

export interface SetUserConcurrencyInput {
  actor: MediaLimitActor;
  userId: string;
  override: number | null;
  reason: string;
  requestId: string;
}

export interface SetUserConcurrencyResult {
  changed: boolean;
  before: number | null;
  after: number | null;
  effectiveConcurrency: number;
  effectiveSource: EffectiveUserConcurrency["effectiveSource"];
  auditLogId: string | null;
  updatedAt: Date;
}

export interface MediaLimitServiceDependencies {
  repository: MediaLimitRepository;
  readPolicy: () => Promise<MediaLimitPolicy>;
  now: () => Date;
  createAuditId: () => string;
  warn: (message: string, data: Record<string, unknown>) => void;
}

const ACTION = "mediaLimits.setUserConcurrencyOverride";
/** 校验并规范管理员必填的变更原因。 */
function parseReason(value: unknown): string {
  if (typeof value !== "string") {
    throw new MediaLimitServiceError("validation_error", "操作原因不合法");
  }
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 300) {
    throw new MediaLimitServiceError(
      "validation_error",
      "操作原因长度必须为 1 至 300 个字符"
    );
  }
  return reason;
}

/** 校验审计链路使用的请求标识，拒绝空值和异常长度。 */
function parseRequestId(value: unknown): string {
  if (typeof value !== "string") {
    throw new MediaLimitServiceError("validation_error", "请求标识不合法");
  }
  const requestId = value.trim();
  if (requestId.length < 1 || requestId.length > 200) {
    throw new MediaLimitServiceError("validation_error", "请求标识不合法");
  }
  return requestId;
}

/** 解析可空用户覆盖；空值表示恢复继承系统默认。 */
function parseOverride(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return parseMediaLimitValue(value, {
      label: "用户生图并发覆盖",
      max: MEDIA_LIMIT_HARD_MAX.userConcurrency,
    });
  } catch {
    throw new MediaLimitServiceError(
      "validation_error",
      "用户生图并发覆盖必须是 1 至 10000 的整数"
    );
  }
}

/** 把数据库 numeric 返回值转换为可空 number，供变更比较和审计使用。 */
function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined || value === ""
    ? null
    : typeof value === "number"
      ? value
      : Number(value);
}

/** 读取并安全解析四项系统媒体限制，单项脏值回退固定默认值。 */
async function readDefaultPolicy(): Promise<MediaLimitPolicy> {
  const { getRuntimeSettingNumber } = await import("../system-settings");
  const [
    defaultUserConcurrency,
    maxFileSizeMb,
    maxUploadSizeMb,
    maxEditReferenceImages,
  ] = await Promise.all([
    getRuntimeSettingNumber(
      "IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY",
      MEDIA_LIMIT_DEFAULTS.defaultUserConcurrency
    ),
    getRuntimeSettingNumber(
      "MEDIA_MAX_FILE_SIZE_MB",
      MEDIA_LIMIT_DEFAULTS.maxFileSizeMb
    ),
    getRuntimeSettingNumber(
      "MEDIA_MAX_UPLOAD_SIZE_MB",
      MEDIA_LIMIT_DEFAULTS.maxUploadSizeMb
    ),
    getRuntimeSettingNumber(
      "IMAGE_EDIT_MAX_REFERENCE_IMAGES",
      MEDIA_LIMIT_DEFAULTS.maxEditReferenceImages
    ),
  ]);
  return resolveMediaLimitPolicy({
    defaultUserConcurrency,
    maxFileSizeMb,
    maxUploadSizeMb,
    maxEditReferenceImages,
  });
}

/**
 * 创建可替换仓储的媒体限制服务。
 *
 * @param dependencies - 仓储、系统策略、时钟、审计 ID 和告警依赖。
 * @returns 用户限制读取及管理员覆盖写入方法。
 */
export function createMediaLimitService(
  dependencies: MediaLimitServiceDependencies
) {
  /** 读取用户覆盖并与当前系统策略合成为唯一生效限制。 */
  async function getForUser(userId: string): Promise<MediaLimitsForUser> {
    const record = await dependencies.repository.readUserConcurrency(userId);
    if (!record) {
      throw new MediaLimitServiceError("not_found", "用户不存在");
    }
    const policy = await dependencies.readPolicy();
    let concurrency: EffectiveUserConcurrency;
    try {
      concurrency = resolveEffectiveUserConcurrency({
        systemDefault: policy.defaultUserConcurrency,
        userOverride: record.override,
      });
    } catch {
      dependencies.warn("用户生图并发覆盖无效，已回退系统默认值", {
        event: "media_limit_invalid_user_override",
        userId,
      });
      concurrency = {
        limit: policy.defaultUserConcurrency,
        override: null,
        effectiveSource: "system_default",
        scope: "user",
      };
    }
    return { ...policy, ...concurrency };
  }

  /** 在角色护栏和行锁内设置覆盖，并与管理员审计原子提交。 */
  async function setUserConcurrencyOverride(
    input: SetUserConcurrencyInput
  ): Promise<SetUserConcurrencyResult> {
    if (input.actor.role !== "admin" && input.actor.role !== "super_admin") {
      throw new MediaLimitServiceError("forbidden", "需要管理员权限");
    }
    const override = parseOverride(input.override);
    const reason = parseReason(input.reason);
    const requestId = parseRequestId(input.requestId);
    const result = await dependencies.repository.transaction(async (tx) => {
      const target = await tx.lockUserConcurrency(input.userId);
      if (!target) {
        throw new MediaLimitServiceError("not_found", "用户不存在");
      }
      if (
        input.actor.role !== "super_admin" &&
        (input.actor.userId === target.id ||
          !canActOnTargetRole(input.actor.role, target.role))
      ) {
        throw new MediaLimitServiceError(
          "forbidden",
          "无权修改该用户的并发限制"
        );
      }

      const before = toNullableNumber(target.override);
      const policy = await dependencies.readPolicy();
      const effective = resolveEffectiveUserConcurrency({
        systemDefault: policy.defaultUserConcurrency,
        userOverride: override,
      });
      if (before === override) {
        return {
          changed: false,
          before,
          after: override,
          effectiveConcurrency: effective.limit,
          effectiveSource: effective.effectiveSource,
          auditLogId: null,
          updatedAt: target.updatedAt,
        } satisfies SetUserConcurrencyResult;
      }

      const updatedAt = dependencies.now();
      const auditLogId = dependencies.createAuditId();
      await tx.updateUserConcurrency({
        userId: target.id,
        override,
        updatedAt,
      });
      await tx.insertAuditLog({
        id: auditLogId,
        adminUserId: input.actor.userId,
        targetUserId: target.id,
        action: ACTION,
        reason,
        before: { imageGenerationConcurrencyOverride: before },
        after: { imageGenerationConcurrencyOverride: override },
        metadata: {
          requestId,
          operation: ACTION,
          actorUserId: input.actor.userId,
          actorRole: input.actor.role,
          targetUserId: target.id,
          targetRole: target.role,
        },
        createdAt: updatedAt,
      });
      return {
        changed: true,
        before,
        after: override,
        effectiveConcurrency: effective.limit,
        effectiveSource: effective.effectiveSource,
        auditLogId,
        updatedAt,
      } satisfies SetUserConcurrencyResult;
    });
    return result;
  }

  return { getForUser, setUserConcurrencyOverride };
}

/** Production reads and atomic audited writes execute in Go. */
export const mediaLimitService: ReturnType<typeof createMediaLimitService> = {
  async getForUser(userId) {
    const { requestGoBackendJson } = await import("../http/go-backend");
    return requestGoBackendJson<MediaLimitsForUser>(
      `/api/image-generation/media-limits?userId=${encodeURIComponent(userId)}`
    );
  },
  async setUserConcurrencyOverride(input) {
    const { requestGoBackendJson } = await import("../http/go-backend");
    const raw = await requestGoBackendJson<Omit<SetUserConcurrencyResult, "updatedAt"> & { updatedAt: string }>(
      `/api/admin/users/${encodeURIComponent(input.userId)}/concurrency`,
      { method: "POST", headers: { "X-Request-ID": input.requestId }, body: JSON.stringify({ userId: input.userId, override: input.override, reason: input.reason }) }
    );
    return { ...raw, updatedAt: new Date(raw.updatedAt) };
  },
};

export { readDefaultPolicy as getMediaLimitPolicy };
export const MEDIA_LIMIT_USER_CONCURRENCY_OPERATION =
  "mediaLimits.setUserConcurrencyOverride" as const;

/** 供媒体入口直接读取系统级限制，不要求先查询用户。 */
export async function getMediaLimitDefaults(): Promise<MediaLimitPolicy> {
  return readDefaultPolicy();
}

/** 设置更新后用于显式失效运行时配置缓存的薄封装。 */
export async function invalidateMediaLimitPolicyCache(): Promise<void> {
  const { invalidateSystemSettingsCache } = await import("../system-settings");
  await invalidateSystemSettingsCache();
}
