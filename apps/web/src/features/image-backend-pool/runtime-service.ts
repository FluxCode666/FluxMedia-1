/**
 * 统一媒体后端号池的运行时会话。
 *
 * 职责：解析当前用户可用分组，以公开模型 ID 从 PostgreSQL 原子获租，加载命中成员的
 * 类型专属配置，并在成功、终态失败或可切换失败后记录成员状态与释放租约。
 * 使用方：图片生成管线与视频状态机；本模块不解析模型前缀决定成员类型。
 */

import { randomUUID } from "node:crypto";
import {
  isPlanAtLeast,
  normalizeSubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import {
  getGroupImageCreditOverrides,
  getGroupVideoCreditOverrides,
  type ImageCreditOverrides,
} from "@repo/shared/image-backend/group-image-pricing";
import { requestParameterMappingsSchema } from "@repo/shared/image-backend/request-parameter-mapping";
import { logWarn } from "@repo/shared/logger";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

import type { ApiConfig } from "@/features/image-generation/types";

import { assertSafeMediaUpstreamUrl } from "./outbound-url-security";
import {
  type AcquiredBackendMemberLease,
  defaultBackendPoolRepository,
} from "./repository";
import { BackendSchedulerError } from "./scheduler";

const IMAGE_LEASE_TTL_MS = 21 * 60 * 1000;
const MAX_MEMBER_ERROR_LENGTH = 1_000;

const groupRowSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  is_enabled: z.boolean(),
  is_default: z.boolean(),
  is_user_selectable: z.boolean(),
  content_safety_enabled: z.boolean().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

const runtimeConfigRowSchema = z.object({
  member_id: z.string().trim().min(1),
  member_type: z.enum(["api", "adobe"]),
  supported_model_ids: z.array(z.string().trim().min(1)).min(1),
  member_content_safety_enabled: z.boolean(),
  api_base_url: z.string().nullable(),
  api_key: z.string().nullable(),
  parameter_mappings: z.unknown().nullable(),
  adobe_mode: z.enum(["gateway", "direct"]).nullable(),
  adobe_base_url: z.string().nullable(),
  adobe_api_key: z.string().nullable(),
  adobe_default_ratio: z.string().nullable(),
  adobe_default_resolution: z.string().nullable(),
  adobe_gpt_image_quality: z.enum(["low", "medium", "high"]).nullable(),
});

/** 统一分组运行时快照。 */
export interface RuntimeBackendGroup {
  id: string;
  name: string;
  contentSafetyEnabled: boolean | null;
  imageCreditOverrides: ImageCreditOverrides;
  videoCreditOverrides: Record<string, number>;
}

/** 已获租成员的运行时协议快照。 */
export interface RuntimeBackendLease {
  acquisition: AcquiredBackendMemberLease;
  config: ApiConfig;
  memberId: string;
  memberType: "api" | "adobe";
  adobeMode: "gateway" | "direct" | null;
  supportedModelIds: string[];
}

/** 调度指标允许记录的稳定结果。 */
export type RuntimeBackendOutcome =
  | "acquired"
  | "switched"
  | "terminal_failure";

/** 创建运行时会话所需的不可变请求事实。 */
export interface CreateRuntimeBackendSessionInput {
  userId: string;
  apiKeyId?: string;
  requestedGroupId?: string;
  pinnedGroupId?: string;
  modelId: string;
  requestKind: "image" | "video";
  imageOperation?: "generate" | "edit";
  requiresContentSafety: boolean;
  requiresMask?: boolean;
}

/** 运行时会话只暴露获租、结果上报和关闭，避免调用方直接操作租约行。 */
export interface RuntimeBackendSession {
  readonly group: RuntimeBackendGroup;
  readonly excludedMemberIds: ReadonlySet<string>;
  current: RuntimeBackendLease | null;
  acquireNext(): Promise<RuntimeBackendLease>;
  switchAfterFailure(
    error: string,
    durationMs: number
  ): Promise<RuntimeBackendLease>;
  completeCurrent(input: {
    success: boolean;
    error?: string;
    durationMs: number;
    terminal?: boolean;
  }): Promise<void>;
  close(): Promise<void>;
}

/** 归一 node-postgres、Neon 与 Drizzle 的 execute 返回形态。 */
function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

/** 将错误压缩为可观测但不含堆栈和凭据的成员状态文本。 */
function sanitizeMemberError(error: string): string {
  return error.replace(/\s+/g, " ").trim().slice(0, MAX_MEMBER_ERROR_LENGTH);
}

/** 从数据库组 metadata 读取套餐门槛，非法值按免费组处理。 */
function getGroupMinimumPlan(metadata: Record<string, unknown> | null) {
  return normalizeSubscriptionPlan(metadata?.minPlan, "free");
}

/** 解析用户本次允许使用的统一分组；显式非默认分组需要套餐选择能力。 */
async function resolveRuntimeBackendGroup(
  input: CreateRuntimeBackendSessionInput
): Promise<RuntimeBackendGroup> {
  const { db } = await import("@repo/database");
  if (input.requestedGroupId && input.pinnedGroupId) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "媒体后端分组不能同时显式选择并由服务端固定"
    );
  }
  const targetGroupId = input.requestedGroupId ?? input.pinnedGroupId;
  const rows = z.array(groupRowSchema).parse(
    extractRows(
      await db.execute(sql`
        select
          id,
          name,
          is_enabled,
          is_default,
          is_user_selectable,
          content_safety_enabled,
          metadata
        from image_backend_group
        where is_enabled = true
        order by
          case when id = ${targetGroupId ?? ""} then 0 else 1 end,
          is_default desc,
          priority asc,
          created_at asc
      `)
    )
  );
  const group = targetGroupId
    ? rows.find((row) => row.id === targetGroupId)
    : (rows.find((row) => row.is_default) ?? rows[0]);
  if (!group) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "当前没有可用的媒体后端分组"
    );
  }

  const userPlan = await getUserPlan(input.userId);
  if (!isPlanAtLeast(userPlan.plan, getGroupMinimumPlan(group.metadata))) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "当前套餐不能使用该媒体后端分组"
    );
  }
  if (
    input.requestedGroupId &&
    !group.is_default &&
    (!group.is_user_selectable ||
      !(await canUsePlanCapability(userPlan.plan, "backendGroups.select")))
  ) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "当前套餐不能手动选择媒体后端分组"
    );
  }

  return {
    id: group.id,
    name: group.name,
    contentSafetyEnabled: group.content_safety_enabled,
    imageCreditOverrides: getGroupImageCreditOverrides(group.metadata),
    videoCreditOverrides: getGroupVideoCreditOverrides(group.metadata),
  };
}

/** 根据统一成员与类型配置表构造现有媒体适配器可消费的配置快照。 */
async function loadRuntimeBackendLease(
  acquisition: AcquiredBackendMemberLease,
  group: RuntimeBackendGroup,
  input: CreateRuntimeBackendSessionInput
): Promise<RuntimeBackendLease> {
  const { db } = await import("@repo/database");
  const rows = z.array(runtimeConfigRowSchema).parse(
    extractRows(
      await db.execute(sql`
        select
          member.id as member_id,
          member.type as member_type,
          member.supported_model_ids,
          member.content_safety_enabled as member_content_safety_enabled,
          api.base_url as api_base_url,
          api.api_key,
          api.parameter_mappings,
          adobe.mode as adobe_mode,
          adobe.base_url as adobe_base_url,
          adobe.api_key as adobe_api_key,
          adobe.default_ratio as adobe_default_ratio,
          adobe.default_resolution as adobe_default_resolution,
          adobe.gpt_image_quality as adobe_gpt_image_quality
        from image_backend_member as member
        left join image_backend_member_api_config as api
          on api.member_id = member.id
        left join image_backend_member_adobe_config as adobe
          on adobe.member_id = member.id
        where member.id = ${acquisition.member.id}
        limit 1
      `)
    )
  );
  const row = rows[0];
  if (!row) throw new Error("获租成员在加载运行时配置前已不存在");

  const commonBackend = {
    id: row.member_id,
    groupId: group.id,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    billingGroupId: group.id,
    imageCreditOverrides: group.imageCreditOverrides,
    videoCreditOverrides: group.videoCreditOverrides,
  };
  const contentSafetyEnabled =
    group.contentSafetyEnabled ?? row.member_content_safety_enabled;

  if (row.member_type === "api") {
    if (!row.api_base_url || !row.api_key) {
      throw new Error("API 成员缺少运行时地址或凭据");
    }
    await assertSafeMediaUpstreamUrl(row.api_base_url);
    return {
      acquisition,
      memberId: row.member_id,
      memberType: "api",
      adobeMode: null,
      supportedModelIds: row.supported_model_ids,
      config: {
        baseUrl: row.api_base_url.replace(/\/+$/, ""),
        apiKey: row.api_key,
        model: input.modelId,
        contentSafetyEnabled,
        backend: {
          ...commonBackend,
          type: "pool-api",
          parameterMappings: requestParameterMappingsSchema.parse(
            row.parameter_mappings ?? []
          ),
        },
      },
    };
  }

  if (
    !row.adobe_mode ||
    !row.adobe_default_ratio ||
    !row.adobe_default_resolution ||
    !row.adobe_gpt_image_quality
  ) {
    throw new Error("Adobe 成员缺少运行时类型配置");
  }
  if (row.adobe_mode === "gateway") {
    if (!row.adobe_base_url || !row.adobe_api_key) {
      throw new Error("Adobe gateway 成员缺少地址或凭据");
    }
    await assertSafeMediaUpstreamUrl(row.adobe_base_url);
  }

  return {
    acquisition,
    memberId: row.member_id,
    memberType: "adobe",
    adobeMode: row.adobe_mode,
    supportedModelIds: row.supported_model_ids,
    config: {
      baseUrl:
        row.adobe_mode === "gateway"
          ? (row.adobe_base_url ?? "").replace(/\/+$/, "")
          : "https://firefly.adobe.com",
      apiKey: row.adobe_mode === "gateway" ? (row.adobe_api_key ?? "") : "",
      model: input.modelId,
      contentSafetyEnabled,
      backend: {
        ...commonBackend,
        type: "pool-adobe",
        adobeMode: row.adobe_mode,
        adobeEnabledModels: row.supported_model_ids,
        adobeSupportsVideo: row.adobe_mode === "direct",
        adobeDefaultRatio: row.adobe_default_ratio,
        adobeDefaultResolution: row.adobe_default_resolution,
        adobeGptImageQuality: row.adobe_gpt_image_quality,
      },
    },
  };
}

/** 以 best-effort 方式记录不含业务载荷的调度指标。 */
async function recordSchedulerMetric(input: {
  sessionInput: CreateRuntimeBackendSessionInput;
  lease: RuntimeBackendLease;
  outcome: RuntimeBackendOutcome;
  durationMs: number;
}): Promise<void> {
  try {
    const { db, imageBackendMemberSchedulerMetric } = await import(
      "@repo/database"
    );
    await db.insert(imageBackendMemberSchedulerMetric).values({
      id: nanoid(),
      bucketStartedAt: new Date(),
      requestKind: input.sessionInput.requestKind,
      strategy: input.lease.acquisition.strategy,
      outcome: input.outcome,
      memberType: input.lease.memberType,
      memberId: input.lease.memberId,
      groupId: input.lease.config.backend?.billingGroupId ?? null,
      eventCount: 1,
      candidateCountTotal: input.lease.acquisition.eligibleCandidateCount,
      latencyMsTotal: Math.max(0, Math.round(input.durationMs)),
    });
  } catch (error) {
    logWarn("统一媒体调度指标写入失败", {
      memberId: input.lease.memberId,
      outcome: input.outcome,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 更新统一成员的健康与使用状态；终态用户错误不处罚成员。 */
async function reportMemberResult(input: {
  lease: RuntimeBackendLease;
  success: boolean;
  terminal: boolean;
  error?: string;
  durationMs: number;
}): Promise<void> {
  const { db } = await import("@repo/database");
  const now = new Date();
  if (input.success) {
    await db.execute(sql`
      update image_backend_member
      set success_count = success_count + 1,
          success_streak = success_streak + 1,
          fail_streak = 0,
          health_status = 'healthy',
          error_ewma = error_ewma * 0.8,
          duration_ms_ewma = case
            when duration_ms_ewma is null then ${Math.max(0, input.durationMs)}
            else duration_ms_ewma * 0.8 + ${Math.max(0, input.durationMs)} * 0.2
          end,
          last_used_at = ${now},
          last_observed_at = ${now},
          last_error = null,
          last_error_at = null,
          updated_at = ${now}
      where id = ${input.lease.memberId}
    `);
    return;
  }
  if (input.terminal) {
    await db.execute(sql`
      update image_backend_member
      set last_used_at = ${now},
          last_observed_at = ${now},
          updated_at = ${now}
      where id = ${input.lease.memberId}
    `);
    return;
  }
  const message = sanitizeMemberError(input.error ?? "媒体上游调用失败");
  await db.execute(sql`
    update image_backend_member
    set fail_count = fail_count + 1,
        fail_streak = fail_streak + 1,
        success_streak = 0,
        health_status = case when fail_streak + 1 >= 3 then 'unhealthy' else 'degraded' end,
        error_ewma = least(1, error_ewma * 0.8 + 0.2),
        status = case when failure_cooldown_enabled then 'limited' else status end,
        cooldown_until = case
          when failure_cooldown_enabled then ${new Date(now.getTime() + 60_000)}
          else cooldown_until
        end,
        last_used_at = ${now},
        last_observed_at = ${now},
        last_error = ${message},
        last_error_at = ${now},
        updated_at = ${now}
    where id = ${input.lease.memberId}
  `);
}

/** 释放 owner-token 租约；重复释放天然幂等。 */
async function releaseRuntimeLease(lease: RuntimeBackendLease): Promise<void> {
  await defaultBackendPoolRepository.releaseLease({
    leaseId: lease.acquisition.lease.id,
    ownerToken: lease.acquisition.lease.ownerToken,
  });
}

/**
 * 创建一次无粘性的统一媒体调度会话。
 *
 * @param input 用户、分组、公开模型和协议资格事实。
 * @returns 同一请求内维护排除集合和当前租约的会话对象。
 */
export async function createRuntimeBackendSession(
  input: CreateRuntimeBackendSessionInput
): Promise<RuntimeBackendSession> {
  const modelId = input.modelId.trim();
  if (!modelId) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "媒体模型 ID 不能为空"
    );
  }
  const normalizedInput = { ...input, modelId };
  const group = await resolveRuntimeBackendGroup(normalizedInput);
  const excludedMemberIds = new Set<string>();
  let current: RuntimeBackendLease | null = null;
  let acquisitionCount = 0;

  let session: RuntimeBackendSession;
  const acquireNext = async (): Promise<RuntimeBackendLease> => {
    const now = new Date();
    const acquisition = await defaultBackendPoolRepository.acquireLease({
      groupId: group.id,
      requestedModel: modelId,
      excludedMemberIds: Array.from(excludedMemberIds),
      requiresContentSafety:
        normalizedInput.requiresContentSafety &&
        group.contentSafetyEnabled !== false,
      leaseId: nanoid(),
      ownerToken: randomUUID(),
      now,
      expiresAt: new Date(now.getTime() + IMAGE_LEASE_TTL_MS),
    });
    if (!acquisition) {
      throw new BackendSchedulerError(
        "no_eligible_member",
        "当前分组没有可用于该模型的媒体后端"
      );
    }

    let lease: RuntimeBackendLease;
    try {
      lease = await loadRuntimeBackendLease(
        acquisition,
        group,
        normalizedInput
      );
    } catch (error) {
      await defaultBackendPoolRepository.releaseLease({
        leaseId: acquisition.lease.id,
        ownerToken: acquisition.lease.ownerToken,
      });
      excludedMemberIds.add(acquisition.member.id);
      logWarn("统一媒体成员运行时配置不可用，已排除并重选", {
        memberId: acquisition.member.id,
        groupId: group.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return acquireNext();
    }

    if (
      (normalizedInput.requiresMask && lease.memberType !== "api") ||
      (normalizedInput.requestKind === "video" &&
        !(lease.memberType === "adobe" && lease.adobeMode === "direct"))
    ) {
      await releaseRuntimeLease(lease);
      excludedMemberIds.add(lease.memberId);
      return acquireNext();
    }

    current = lease;
    session.current = lease;
    await recordSchedulerMetric({
      sessionInput: normalizedInput,
      lease,
      outcome: acquisitionCount > 0 ? "switched" : "acquired",
      durationMs: 0,
    });
    acquisitionCount += 1;
    return lease;
  };

  session = {
    group,
    excludedMemberIds,
    current,
    acquireNext,

    async switchAfterFailure(error, durationMs) {
      const lease = current;
      if (!lease) throw new Error("没有可切换的当前媒体成员租约");
      excludedMemberIds.add(lease.memberId);
      await reportMemberResult({
        lease,
        success: false,
        terminal: false,
        error,
        durationMs,
      });
      await releaseRuntimeLease(lease);
      current = null;
      session.current = null;
      return acquireNext();
    },

    async completeCurrent(result) {
      const lease = current;
      if (!lease) return;
      await reportMemberResult({
        lease,
        success: result.success,
        terminal: result.terminal ?? false,
        error: result.error,
        durationMs: result.durationMs,
      });
      if (!result.success && result.terminal) {
        await recordSchedulerMetric({
          sessionInput: normalizedInput,
          lease,
          outcome: "terminal_failure",
          durationMs: result.durationMs,
        });
      }
      await releaseRuntimeLease(lease);
      current = null;
      session.current = null;
    },

    async close() {
      const lease = current;
      if (!lease) return;
      await releaseRuntimeLease(lease);
      current = null;
      session.current = null;
    },
  };

  return session;
}
