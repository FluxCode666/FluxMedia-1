/**
 * 统一媒体后端号池的运行时会话。
 *
 * 职责：解析当前用户可用分组，以公开模型 ID 从 PostgreSQL 原子获租，加载命中成员的
 * 类型专属配置，并在成功、终态失败或可切换失败后记录成员状态与释放租约。
 * 使用方：图片生成管线与视频状态机；本模块不解析模型前缀决定成员类型。
 */

import { randomUUID } from "node:crypto";
import {
  apiModelMappingsSchema,
  apiUpstreamAdapterDraftSchema,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  getGroupImageCreditOverrides,
  getGroupVideoCreditOverrides,
  type ImageCreditOverrides,
} from "@repo/shared/image-backend/group-image-pricing";
import type { BackendSchedulingStrategy } from "@repo/shared/image-backend/scheduling-policy";
import { logWarn } from "@repo/shared/logger";
import { type SQL, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

import type { ApiConfig } from "@/features/image-generation/types";
import { extractExecuteRows } from "@/server/database-result";

import { parseMediaUpstreamUrl } from "./media-upstream-url";
import {
  type AcquiredBackendMemberLease,
  defaultBackendPoolRepository,
} from "./repository";
import {
  selectRuntimeBackendGroupCandidate,
  selectTrustedRuntimeGroupTarget,
} from "./runtime-group-selection";
import { normalizeRuntimeRequestedModelId } from "./runtime-model-matching";
import { canRuntimeBackendLeaseServeRequest } from "./runtime-protocol-eligibility";
import { projectConfiguredVideoModelIds } from "./runtime-video-reachability";
import { BackendSchedulerError } from "./scheduler-error";

const IMAGE_LEASE_TTL_MS = 21 * 60 * 1000;
const MAX_MEMBER_ERROR_LENGTH = 1_000;

const groupRowSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  isEnabled: z.boolean(),
  isDefault: z.boolean(),
  isUserSelectable: z.boolean(),
  contentSafetyEnabled: z.boolean().nullable(),
  priority: z.number().int().min(0).max(10_000),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

const apiKeyGroupBindingRowSchema = z.object({
  generation_group_id: z.string().trim().min(1).nullable(),
});

const configuredModelIdsRowSchema = z.object({
  member_type: z.enum(["api", "adobe"]),
  adobe_mode: z.enum(["gateway", "direct"]).nullable(),
  supported_model_ids: z.array(z.string().trim().min(1)),
});

const apiVideoRecoveryRowSchema = z.object({
  member_id: z.string().trim().min(1),
  credential_scope: z.string().trim().min(1),
  api_key: z.string().min(1),
  adapter_configuration: z.unknown(),
});

/** 固定版本视频恢复只需要参数化 SQL 执行端口，真实 PostgreSQL 测试可注入连接。 */
export interface ApiVideoRecoveryConfigDatabase {
  execute(query: SQL): Promise<unknown>;
}

const runtimeConfigRowSchema = z.object({
  member_id: z.string().trim().min(1),
  member_type: z.enum(["api", "adobe"]),
  supported_model_ids: z.array(z.string().trim().min(1)).min(1),
  member_content_safety_enabled: z.boolean(),
  api_key: z.string().nullable(),
  api_credential_scope: z.string().nullable(),
  api_adapter_member_id: z.string().nullable(),
  api_adapter_version_id: z.string().nullable(),
  api_adapter_configuration: z.unknown().nullable(),
  adobe_mode: z.enum(["gateway", "direct"]).nullable(),
  adobe_base_url: z.string().nullable(),
  adobe_api_key: z.string().nullable(),
  adobe_default_ratio: z.string().nullable(),
  adobe_default_resolution: z.string().nullable(),
  adobe_gpt_image_quality: z.enum(["low", "medium", "high"]).nullable(),
});

/** 准入时固定的统一分组运行时快照。 */
export interface RuntimeBackendGroupSnapshot {
  id: string;
  name: string;
  priority: number;
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
}

/** 调度指标允许记录的稳定结果。 */
export type RuntimeBackendOutcome =
  | "acquired"
  | "capacity_rejected"
  | "no_candidate"
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
  requiresContentSafety: boolean;
  requiresMask?: boolean;
  /** 当前任务已耗尽或明确排除的账号；只影响本次会话。 */
  excludedMemberIds?: readonly string[];
  /** 同账号创建重试时只允许重新获取该账号。 */
  requiredMemberId?: string;
}

/** 配置可达性查询所需的 Principal 分组事实。 */
export interface ListConfiguredRuntimeModelIdsInput {
  userId: string;
  apiKeyId?: string;
  requestedGroupId?: string;
  pinnedGroupId?: string;
}

/** 运行时会话只暴露获租、结果上报和关闭，避免调用方直接操作租约行。 */
export interface RuntimeBackendSession {
  readonly group: RuntimeBackendGroupSnapshot;
  readonly current: RuntimeBackendLease | null;
  acquireNext(): Promise<RuntimeBackendLease>;
  switchAfterFailure(
    error: string,
    durationMs: number
  ): Promise<RuntimeBackendLease>;
  /** 仅在当前任务排除账号并切换，不修改账号全局健康与冷却。 */
  switchForTask(): Promise<RuntimeBackendLease>;
  completeCurrent(input: {
    success: boolean;
    error?: string;
    durationMs: number;
    terminal?: boolean;
  }): Promise<void>;
  close(): Promise<void>;
}

/** 将错误压缩为可观测但不含堆栈和凭据的成员状态文本。 */
function sanitizeMemberError(error: string): string {
  return error.replace(/\s+/g, " ").trim().slice(0, MAX_MEMBER_ERROR_LENGTH);
}

/** 从数据库加载 API Key 绑定后，委托纯函数完成可信分组选择。 */
type RuntimeGroupTargetInput = Pick<
  CreateRuntimeBackendSessionInput,
  "userId" | "apiKeyId" | "requestedGroupId" | "pinnedGroupId"
>;

async function resolveTrustedRuntimeGroupTarget(
  input: RuntimeGroupTargetInput
): Promise<{ targetGroupId: string | undefined; isUserRequested: boolean }> {
  if (!input.apiKeyId) return selectTrustedRuntimeGroupTarget(input);
  const { db } = await import("@repo/database");
  const rows = z.array(apiKeyGroupBindingRowSchema).parse(
    extractExecuteRows(
      await db.execute(sql`
        select generation_group_id
        from external_api_key
        where id = ${input.apiKeyId}
          and user_id = ${input.userId}
          and is_active = true
        limit 1
      `)
    )
  );
  const key = rows[0];
  return selectTrustedRuntimeGroupTarget(
    input,
    key ? { groupId: key.generation_group_id } : undefined
  );
}

/**
 * 解析可信分组并固定后续队列与执行使用的治理快照。
 *
 * @param input 用户、API Key 绑定或站内显式分组事实。
 * @returns 分组 ID、任务队列 priority、内容安全和计费覆盖快照。
 * @sideEffects 只读 API Key 与分组配置，不获取成员租约或写调度指标。
 * @throws 目标不可用、用户选择不可选组或不存在启用默认组时 fail closed。
 */
export async function resolveTrustedGroupSnapshot(
  input: ListConfiguredRuntimeModelIdsInput
): Promise<RuntimeBackendGroupSnapshot> {
  const { db } = await import("@repo/database");
  const { targetGroupId, isUserRequested } =
    await resolveTrustedRuntimeGroupTarget(input);
  const rows = z.array(groupRowSchema).parse(
    extractExecuteRows(
      await db.execute(sql`
        select
          id,
          name,
          is_enabled as "isEnabled",
          is_default as "isDefault",
          is_user_selectable as "isUserSelectable",
          content_safety_enabled as "contentSafetyEnabled",
          priority,
          metadata
        from image_backend_group
        where is_enabled = true
        order by created_at asc, id asc
      `)
    )
  );
  const group = selectRuntimeBackendGroupCandidate(rows, {
    ...(targetGroupId !== undefined && { targetGroupId }),
    isUserRequested,
  });

  return {
    id: group.id,
    name: group.name,
    priority: group.priority,
    contentSafetyEnabled: group.contentSafetyEnabled,
    imageCreditOverrides: getGroupImageCreditOverrides(group.metadata),
    videoCreditOverrides: getGroupVideoCreditOverrides(group.metadata),
  };
}

/**
 * 读取当前 Principal 可信分组中已配置的模型 ID。
 *
 * @param input - 用户、可选外部 API Key 绑定和站内显式分组选择。
 * @returns 去重后的成员配置模型 ID；忽略健康、冷却、租约、并发和实时容量。
 * @sideEffects 读取 API Key 绑定、分组与成员配置，不获取租约也不更新成员状态。
 * @throws 分组不可达或 API Key 覆盖时沿用运行时选择错误。
 */
export async function listConfiguredRuntimeModelIds(
  input: ListConfiguredRuntimeModelIdsInput
): Promise<string[]> {
  const group = await resolveTrustedGroupSnapshot({
    ...input,
  });
  const { db } = await import("@repo/database");
  const rows = z.array(configuredModelIdsRowSchema).parse(
    extractExecuteRows(
      await db.execute(sql`
        select
          member.type as member_type,
          adobe.mode as adobe_mode,
          member.supported_model_ids
        from image_backend_member as member
        inner join image_backend_member_group as membership
          on membership.member_id = member.id
        left join image_backend_member_adobe_config as adobe
          on adobe.member_id = member.id
        where membership.group_id = ${group.id}
          and member.is_enabled = true
        order by member.id asc
      `)
    )
  );
  return projectConfiguredVideoModelIds(
    rows.map((row) => ({
      memberType: row.member_type,
      adobeMode: row.adobe_mode,
      supportedModelIds: row.supported_model_ids,
    }))
  );
}

/**
 * 加载已接受视频任务固定 API 账号的当前凭据。
 *
 * @param memberId - 任务在接受阶段持久化的统一账号 ID。
 * @param apiAdapterMemberId - 固定适配版本的成员快照，必须与统一账号一致。
 * @param apiAdapterVersionId - 提交时固定的不可变版本 ID。
 * @returns 原账号仍存在且类型配置完整时返回最小 API 运行时配置，否则返回 null。
 * @sideEffects 读取统一账号及 API 配置；不获取新租约、不切换账号、不更新健康状态。
 * @failure 数据库结果形状非法时由 Zod 抛出；URL 非 HTTP(S) 时显式失败。
 */
export async function loadApiVideoRecoveryConfig(
  memberId: string,
  apiAdapterMemberId: string,
  apiAdapterVersionId: string,
  modelId: string,
  database?: ApiVideoRecoveryConfigDatabase
): Promise<ApiConfig | null> {
  const queryDatabase = database ?? (await import("@repo/database")).db;
  const rows = z.array(apiVideoRecoveryRowSchema).parse(
    extractExecuteRows(
      await queryDatabase.execute(sql`
        select
          member.id as member_id,
          api.credential_scope,
          api.api_key,
          version.configuration as adapter_configuration
        from image_backend_member as member
        inner join image_backend_member_api_config as api
          on api.member_id = member.id
        inner join image_backend_member_api_adapter_version as version
          on version.member_id_snapshot = ${apiAdapterMemberId}
          and version.id = ${apiAdapterVersionId}
          and version.credential_scope = api.credential_scope
        where member.id = ${memberId}
          and member.id = ${apiAdapterMemberId}
          and member.type = 'api'
        limit 1
      `)
    )
  );
  const row = rows[0];
  if (!row) return null;
  const adapter = apiUpstreamAdapterDraftSchema.parse(
    row.adapter_configuration
  );
  if (adapter.credentialScope !== row.credential_scope) {
    throw new Error("API 视频恢复凭据域与固定适配版本不一致");
  }
  parseMediaUpstreamUrl(adapter.baseUrl);
  return {
    baseUrl: adapter.baseUrl.replace(/\/+$/, ""),
    apiKey: row.api_key,
    model: modelId,
    useStream: adapter.useStream,
    backend: {
      type: "pool-api",
      id: row.member_id,
      modelMappings: adapter.modelMappings,
      apiUpstreamAdapter: adapter,
    },
  };
}

/** 根据统一成员与类型配置表构造现有媒体适配器可消费的配置快照。 */
async function loadRuntimeBackendLease(
  acquisition: AcquiredBackendMemberLease,
  group: RuntimeBackendGroupSnapshot,
  input: CreateRuntimeBackendSessionInput
): Promise<RuntimeBackendLease> {
  const { db } = await import("@repo/database");
  const rows = z.array(runtimeConfigRowSchema).parse(
    extractExecuteRows(
      await db.execute(sql`
        select
          member.id as member_id,
          member.type as member_type,
          member.supported_model_ids,
          member.content_safety_enabled as member_content_safety_enabled,
          api.api_key,
          api.credential_scope as api_credential_scope,
          lease.api_adapter_member_id,
          lease.api_adapter_version_id,
          api_version.configuration as api_adapter_configuration,
          adobe.mode as adobe_mode,
          adobe.base_url as adobe_base_url,
          adobe.api_key as adobe_api_key,
          adobe.default_ratio as adobe_default_ratio,
          adobe.default_resolution as adobe_default_resolution,
          adobe.gpt_image_quality as adobe_gpt_image_quality
        from image_backend_member as member
        left join image_backend_member_lease as lease
          on lease.id = ${acquisition.lease.id}
          and lease.member_id = member.id
        left join image_backend_member_api_config as api
          on api.member_id = member.id
        left join image_backend_member_api_adapter_version as api_version
          on api_version.member_id_snapshot = lease.api_adapter_member_id
          and api_version.id = lease.api_adapter_version_id
          and api_version.credential_scope = api.credential_scope
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
    name: acquisition.member.name,
    groupId: group.id,
    userId: input.userId,
    ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
    billingGroupId: group.id,
    imageCreditOverrides: group.imageCreditOverrides,
    videoCreditOverrides: group.videoCreditOverrides,
  };
  const contentSafetyEnabled =
    group.contentSafetyEnabled ?? row.member_content_safety_enabled;

  if (row.member_type === "api") {
    if (
      !row.api_key ||
      !row.api_credential_scope ||
      !row.api_adapter_member_id ||
      !row.api_adapter_version_id ||
      !row.api_adapter_configuration ||
      row.api_adapter_member_id !== row.member_id
    ) {
      throw new Error("API 成员缺少固定适配版本、地址或凭据");
    }
    const adapter = apiUpstreamAdapterDraftSchema.parse(
      row.api_adapter_configuration
    );
    if (adapter.credentialScope !== row.api_credential_scope) {
      throw new Error("API 成员当前凭据域与固定适配版本不一致");
    }
    parseMediaUpstreamUrl(adapter.baseUrl);
    return {
      acquisition,
      memberId: row.member_id,
      memberType: "api",
      adobeMode: null,
      config: {
        baseUrl: adapter.baseUrl.replace(/\/+$/, ""),
        apiKey: row.api_key,
        model: input.modelId,
        useStream: adapter.useStream,
        contentSafetyEnabled,
        backend: {
          ...commonBackend,
          type: "pool-api",
          modelMappings: apiModelMappingsSchema.parse(adapter.modelMappings),
          apiUpstreamAdapter: adapter,
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
    parseMediaUpstreamUrl(row.adobe_base_url);
  }

  return {
    acquisition,
    memberId: row.member_id,
    memberType: "adobe",
    adobeMode: row.adobe_mode,
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
  strategy: BackendSchedulingStrategy;
  outcome: RuntimeBackendOutcome;
  durationMs: number;
  groupId: string;
  candidateCount: number;
  lease?: RuntimeBackendLease;
}): Promise<void> {
  try {
    const { db, imageBackendMemberSchedulerMetric } = await import(
      "@repo/database"
    );
    const now = new Date();
    const latencyMs = Math.max(0, Math.round(input.durationMs));
    await db
      .insert(imageBackendMemberSchedulerMetric)
      .values({
        id: nanoid(),
        bucketStartedAt: new Date(Math.floor(now.getTime() / 60_000) * 60_000),
        requestKind: input.sessionInput.requestKind,
        strategy: input.strategy,
        outcome: input.outcome,
        memberType: input.lease?.memberType ?? null,
        memberId: input.lease?.memberId ?? null,
        groupId: input.groupId,
        eventCount: 1,
        candidateCountTotal: input.candidateCount,
        latencyMsTotal: latencyMs,
      })
      .onConflictDoUpdate({
        target: [
          imageBackendMemberSchedulerMetric.bucketStartedAt,
          imageBackendMemberSchedulerMetric.requestKind,
          imageBackendMemberSchedulerMetric.strategy,
          imageBackendMemberSchedulerMetric.outcome,
          imageBackendMemberSchedulerMetric.memberType,
          imageBackendMemberSchedulerMetric.memberId,
          imageBackendMemberSchedulerMetric.groupId,
        ],
        set: {
          eventCount: sql`${imageBackendMemberSchedulerMetric.eventCount} + 1`,
          candidateCountTotal: sql`${imageBackendMemberSchedulerMetric.candidateCountTotal} + ${input.candidateCount}`,
          latencyMsTotal: sql`${imageBackendMemberSchedulerMetric.latencyMsTotal} + ${latencyMs}`,
          updatedAt: now,
        },
      });
  } catch (error) {
    logWarn("统一媒体调度指标写入失败", {
      memberId: input.lease?.memberId ?? null,
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
          status = case when status = 'limited' then 'active' else status end,
          cooldown_until = case
            when status = 'limited' then null
            else cooldown_until
          end,
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
  input: CreateRuntimeBackendSessionInput,
  trustedGroupSnapshot?: RuntimeBackendGroupSnapshot
): Promise<RuntimeBackendSession> {
  const modelId = normalizeRuntimeRequestedModelId(input);
  if (!modelId) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      input.requestKind === "video"
        ? "视频模型 ID 必须是全局目录中的真实模型 ID"
        : "媒体模型 ID 不能为空"
    );
  }
  const normalizedInput = { ...input, modelId };
  const group =
    trustedGroupSnapshot ??
    (await resolveTrustedGroupSnapshot(normalizedInput));
  const excludedMemberIds = new Set(input.excludedMemberIds ?? []);
  let current: RuntimeBackendLease | null = null;
  let acquisitionCount = 0;

  const acquireNext = async (): Promise<RuntimeBackendLease> => {
    const now = new Date();
    const startedAt = Date.now();
    const acquisitionResult = await defaultBackendPoolRepository.acquireLease({
      groupId: group.id,
      requestedModel: modelId,
      excludedMemberIds: Array.from(excludedMemberIds),
      ...(normalizedInput.requiredMemberId
        ? { requiredMemberId: normalizedInput.requiredMemberId }
        : {}),
      requiresContentSafety:
        normalizedInput.requiresContentSafety &&
        group.contentSafetyEnabled !== false,
      leaseId: nanoid(),
      ownerToken: randomUUID(),
      now,
      expiresAt: new Date(now.getTime() + IMAGE_LEASE_TTL_MS),
    });
    if (acquisitionResult.status !== "acquired") {
      await recordSchedulerMetric({
        sessionInput: normalizedInput,
        strategy: acquisitionResult.strategy,
        outcome: acquisitionResult.status,
        durationMs: Date.now() - startedAt,
        groupId: group.id,
        candidateCount: acquisitionResult.eligibleCandidateCount,
      });
      throw new BackendSchedulerError(
        acquisitionResult.status === "capacity_rejected"
          ? "capacity_rejected"
          : "no_eligible_member",
        acquisitionResult.status === "capacity_rejected"
          ? "当前分组的媒体后端容量已满"
          : "当前分组没有可用于该模型的媒体后端"
      );
    }
    const acquisition = acquisitionResult.acquisition;

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

    if (!canRuntimeBackendLeaseServeRequest(normalizedInput, lease)) {
      await releaseRuntimeLease(lease);
      excludedMemberIds.add(lease.memberId);
      return acquireNext();
    }

    current = lease;
    await recordSchedulerMetric({
      sessionInput: normalizedInput,
      strategy: acquisition.strategy,
      lease,
      outcome: acquisitionCount > 0 ? "switched" : "acquired",
      durationMs: Date.now() - startedAt,
      groupId: group.id,
      candidateCount: acquisition.eligibleCandidateCount,
    });
    acquisitionCount += 1;
    return lease;
  };

  const session: RuntimeBackendSession = {
    group,
    get current() {
      return current;
    },
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
      return acquireNext();
    },

    async switchForTask() {
      const lease = current;
      if (!lease) throw new Error("没有可切换的当前媒体成员租约");
      excludedMemberIds.add(lease.memberId);
      await releaseRuntimeLease(lease);
      current = null;
      return acquireNext();
    },

    async completeCurrent(result) {
      const lease = current;
      if (!lease) return;
      await reportMemberResult({
        lease,
        success: result.success,
        terminal: result.terminal ?? false,
        ...(result.error ? { error: result.error } : {}),
        durationMs: result.durationMs,
      });
      if (!result.success && result.terminal) {
        await recordSchedulerMetric({
          sessionInput: normalizedInput,
          strategy: lease.acquisition.strategy,
          lease,
          outcome: "terminal_failure",
          durationMs: result.durationMs,
          groupId: group.id,
          candidateCount: lease.acquisition.eligibleCandidateCount,
        });
      }
      await releaseRuntimeLease(lease);
      current = null;
    },

    async close() {
      const lease = current;
      if (!lease) return;
      await releaseRuntimeLease(lease);
      current = null;
    },
  };

  return session;
}

/**
 * 使用已在用户准入阶段固定的分组快照创建成员会话。
 *
 * @param input 用户、模型和协议资格事实。
 * @param trustedGroupSnapshot 已通过 resolveTrustedGroupSnapshot 的不可变快照。
 * @returns 延迟到 acquireNext 才获取成员租约的运行时会话。
 * @sideEffects 创建会话对象；调用 acquireNext 后才会获取成员租约。
 */
export async function createRuntimeBackendSessionFromSnapshot(
  input: CreateRuntimeBackendSessionInput,
  trustedGroupSnapshot: RuntimeBackendGroupSnapshot
): Promise<RuntimeBackendSession> {
  return createRuntimeBackendSession(input, trustedGroupSnapshot);
}
