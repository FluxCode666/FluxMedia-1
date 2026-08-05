/**
 * UOL Operations - 媒体限制领域。
 *
 * 职责：把媒体资源限制和用户并发覆盖暴露为传输无关 operation。读取操作允许站内
 * 用户、外部 API Key、MCP Key 与 system 共享；写入只接受真实管理员会话。
 * 关键依赖：media-limit-service、Principal、defineOperation。
 */

import { z } from "zod";

import {
  MEDIA_LIMIT_HARD_MAX,
  userConcurrencyOverrideSchema,
} from "../../image-generation/media-limit-policy";
import {
  type MediaLimitActor,
  MediaLimitServiceError,
  mediaLimitService,
} from "../../image-generation/media-limit-service";
import { OperationError } from "../errors";
import { getPrincipalUserId, type Principal } from "../principal";
import { defineOperation } from "../registry";

const mediaLimitOutputSchema = z
  .object({
    defaultUserConcurrency: z.number().int().min(1).max(10_000),
    maxFileSizeMb: z.number().int().min(1).max(200),
    maxUploadSizeMb: z.number().int().min(1).max(200),
    maxEditReferenceImages: z.number().int().min(1).max(256),
    maxFileSizeBytes: z.number().int().positive(),
    maxUploadSizeBytes: z.number().int().positive(),
    limit: z.number().int().min(1).max(10_000),
    override: userConcurrencyOverrideSchema,
    effectiveSource: z.enum(["system_default", "user_override"]),
    scope: z.literal("user"),
  })
  .strict();

const userConcurrencyWriteResultSchema = z
  .object({
    changed: z.boolean(),
    before: userConcurrencyOverrideSchema,
    after: userConcurrencyOverrideSchema,
    effectiveConcurrency: z
      .number()
      .int()
      .min(1)
      .max(MEDIA_LIMIT_HARD_MAX.userConcurrency),
    effectiveSource: z.enum(["system_default", "user_override"]),
    auditLogId: z.string().nullable(),
    updatedAt: z.date(),
  })
  .strict();

/** 仅把真实站内用户 Principal 转换为管理员 actor。 */
function requireActor(principal: Principal): MediaLimitActor {
  if (principal.type !== "user") {
    throw new OperationError("forbidden", "需要真实管理员会话");
  }
  return { userId: principal.userId, role: principal.role };
}

/**
 * 解析读取目标并落实归属校验；system 必须显式声明目标用户。
 */
function resolveOwnedUserId(
  principal: Principal,
  requestedUserId: string | undefined
): string {
  if (principal.type === "system") {
    if (!requestedUserId) {
      throw new OperationError(
        "validation_error",
        "system 调用必须提供 userId"
      );
    }
    return requestedUserId;
  }
  const principalUserId = getPrincipalUserId(principal);
  if (!principalUserId) {
    throw new OperationError("unauthenticated", "需要用户身份");
  }
  if (requestedUserId && requestedUserId !== principalUserId) {
    if (
      principal.type === "user" &&
      ["observer_admin", "admin", "super_admin"].includes(principal.role)
    ) {
      return requestedUserId;
    }
    throw new OperationError(
      "ownership_violation",
      "不能读取其他用户的媒体限制"
    );
  }
  return principalUserId;
}

/** 将服务错误收敛为稳定的 UOL 错误码，隐藏内部不变量细节。 */
async function invokeMediaLimitService<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof MediaLimitServiceError)) throw error;
    if (error.code === "invariant_error") {
      throw new OperationError("internal_error", "媒体限制服务暂时不可用");
    }
    throw new OperationError(error.code, error.message);
  }
}

/** 读取当前 Principal 所属用户的唯一生效媒体限制。 */
export const mediaLimitsGetEffective = defineOperation({
  name: "mediaLimits.getEffective",
  domain: "image-generation",
  title: "Get Effective Media Limits",
  description: "读取用户生图并发、文件大小、上传总量和编辑参考图的生效限制。",
  input: z.object({ userId: z.string().trim().min(1).optional() }).strict(),
  output: mediaLimitOutputSchema,
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  processLocalState: false,
  execute: async (input, principal) =>
    invokeMediaLimitService(() =>
      mediaLimitService.getForUser(resolveOwnedUserId(principal, input.userId))
    ),
});

/** 设置或清空目标用户的生图并发覆盖，并在同一事务写入管理员审计。 */
export const mediaLimitsSetUserConcurrencyOverride = defineOperation({
  name: "mediaLimits.setUserConcurrencyOverride",
  domain: "image-generation",
  title: "Set User Image Generation Concurrency Override",
  description: "管理员设置用户生图并发覆盖；null 表示恢复继承系统默认值。",
  input: z
    .object({
      userId: z.string().trim().min(1),
      override: userConcurrencyOverrideSchema,
      reason: z.string().trim().min(1).max(300),
    })
    .strict(),
  output: userConcurrencyWriteResultSchema,
  access: { kind: "roles", roles: ["admin", "super_admin"] },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["audit"],
  processLocalState: false,
  execute: async (input, principal, context) =>
    invokeMediaLimitService(() =>
      mediaLimitService.setUserConcurrencyOverride({
        actor: requireActor(principal),
        userId: input.userId,
        override: input.override,
        reason: input.reason,
        requestId: context.requestId,
      })
    ),
});

export { mediaLimitOutputSchema };
