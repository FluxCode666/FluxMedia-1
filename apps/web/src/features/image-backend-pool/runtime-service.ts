/**
 * 统一媒体后端号池的运行时会话。
 *
 * 职责：解析当前用户可用分组，以公开模型 ID 从 PostgreSQL 原子获租，加载命中成员的
 * 类型专属配置，并在成功、终态失败或可切换失败后记录成员状态与释放租约。
 * 使用方：图片生成管线与视频状态机；本模块不解析模型前缀决定成员类型。
 */

import { randomUUID } from "node:crypto";
import {
  resolveVideoBillingQuote,
  type VideoBillingQuote,
} from "@repo/shared/adobe";
import {
  apiModelMappingsSchema,
  apiUpstreamAdapterDraftSchema,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  getGroupImageCreditOverrides,
  getGroupVideoCreditOverrides,
  getGroupVideoCreditsPerItemOverrides,
  type ImageCreditOverrides,
} from "@repo/shared/image-backend/group-image-pricing";
import type { BackendSchedulingStrategy } from "@repo/shared/image-backend/scheduling-policy";
import { logWarn } from "@repo/shared/logger";
import {
  isModelMarketplaceModelEnabled,
  type ModelMarketplaceConfig,
  parseModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import {
  normalizeVideoModelBillingSettings,
  type VideoModelBillingSettings,
} from "@repo/shared/system-settings/video-billing-settings";
import {
  parseVideoModelCapabilityOverrides,
  type VideoModelCapabilityOverrides,
} from "@repo/shared/video-generation";
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

const authoritativeVideoQuoteRowSchema = z
  .object({
    settings: z.record(z.string(), z.unknown()),
    api_key_found: z.boolean(),
    api_key_group_id: z.string().trim().min(1).nullable(),
    groups: z.array(groupRowSchema),
  })
  .strict();

const configuredModelIdsRowSchema = z.object({
  member_type: z.enum(["api", "adobe"]),
  adobe_mode: z.enum(["gateway", "direct"]).nullable(),
  supported_model_ids: z.array(z.string().trim().min(1)),
});

const runtimeAvailabilityRowSchema = z.object({
  eligible_count: z.coerce.number().int().nonnegative(),
  available_count: z.coerce.number().int().nonnegative(),
});

const apiVideoRecoveryRowSchema = z.object({
  member_id: z.string().trim().min(1),
  credential_scope: z.string().trim().min(1),
  api_key: z.string().min(1).nullable(),
  adapter_configuration: z.unknown(),
});

/** 固定版本视频恢复只需要参数化 SQL 执行端口，真实 PostgreSQL 测试可注入连接。 */
export interface ApiVideoRecoveryConfigDatabase {
  execute(query: SQL): Promise<unknown>;
}

/** 固定 API 适配版本存在但内容无法安全重放。 */
export class ApiVideoRecoveryConfigInvalidError extends Error {
  constructor() {
    super("API 视频恢复固定适配版本无效");
    this.name = "ApiVideoRecoveryConfigInvalidError";
  }
}

/** 已获租成员的持久运行时配置缺失或损坏，可以排除该成员后重选。 */
export class RuntimeBackendConfigurationInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeBackendConfigurationInvalidError";
  }
}

/**
 * 区分获租后配置加载的永久成员错误与临时基础设施错误。
 *
 * @param error 加载运行时配置时捕获的未知异常。
 * @returns 只有已分类的永久配置损坏允许排除成员，其余必须交队列稍后重试。
 * @sideEffects 无。
 * @failure 不抛错；未知异常保守返回 retry_later。
 */
export function classifyRuntimeBackendLeaseLoadFailure(
  error: unknown
): "exclude_member" | "retry_later" {
  return error instanceof RuntimeBackendConfigurationInvalidError
    ? "exclude_member"
    : "retry_later";
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
  videoCreditsPerItemOverrides: Record<string, number>;
}

/** 创建视频任务时权威报价读取所需的既有事务 SQL 端口。 */
export interface RuntimeVideoQuoteTransactionDatabase {
  execute(query: SQL): Promise<unknown>;
}

/** 首次视频准入在同一 MVCC statement snapshot 中固定的计费与治理事实。 */
export interface AuthoritativeRuntimeVideoQuote {
  pinnedGroupId: string;
  group: RuntimeBackendGroupSnapshot;
  quote: VideoBillingQuote;
  marketplaceConfig: ModelMarketplaceConfig;
  videoCapabilityOverrides: VideoModelCapabilityOverrides;
}

/** 一次权威读取可供能力列表解析多个模型与分辨率的计费上下文。 */
export interface AuthoritativeRuntimeVideoPricingContext {
  pinnedGroupId: string;
  group: RuntimeBackendGroupSnapshot;
  marketplaceConfig: ModelMarketplaceConfig;
  videoCapabilityOverrides: VideoModelCapabilityOverrides;
  billing: VideoModelBillingSettings;
}

/** 读取权威视频计费上下文所需的可信 Principal 分组事实。 */
export type ResolveAuthoritativeRuntimeVideoPricingContextInput = Pick<
  ResolveAuthoritativeRuntimeVideoQuoteInput,
  "userId" | "apiKeyId" | "requestedGroupId" | "pinnedGroupId"
>;

/** 生成视频账单快照所需的外部请求与可信身份事实。 */
export interface ResolveAuthoritativeRuntimeVideoQuoteInput {
  userId: string;
  apiKeyId?: string;
  requestedGroupId?: string;
  pinnedGroupId?: string;
  modelId: string;
  resolution: string;
  durationSeconds: number;
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
  /** 协议恢复必须固定成员类型，避免 API 重试漂移到 Adobe Direct。 */
  requiredMemberType?: "api" | "adobe";
  /** 同账号重试固定使用首次选择时持久化的 API 适配版本。 */
  requiredApiAdapterMemberId?: string;
  requiredApiAdapterVersionId?: string;
}

/** 配置可达性查询所需的 Principal 分组事实。 */
export interface ListConfiguredRuntimeModelIdsInput {
  userId: string;
  apiKeyId?: string;
  requestedGroupId?: string;
  pinnedGroupId?: string;
}

/** 创建响应前只读资格裁决的稳定结果。 */
export type RuntimeBackendAvailability =
  | "available"
  | "capacity_rejected"
  | "no_candidate";

/** 只读视频账号资格裁决使用的最小数据库端口。 */
export interface RuntimeVideoBackendAvailabilityDatabase {
  execute(query: SQL): Promise<unknown>;
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
 * 将经选择器验证的分组行投影为后续调度和计费共用的不可变快照。
 *
 * @param group - 已确认启用、绑定关系合法且可供当前 Principal 使用的分组。
 * @returns 不含成员、凭据或动态容量的治理与两套稀疏价格覆盖。
 * @sideEffects 无。
 * @failure metadata 单字段损坏时对应覆盖为空，避免用按秒值污染按条计费。
 */
function createRuntimeBackendGroupSnapshot(
  group: z.output<typeof groupRowSchema>
): RuntimeBackendGroupSnapshot {
  return {
    id: group.id,
    name: group.name,
    priority: group.priority,
    contentSafetyEnabled: group.contentSafetyEnabled,
    imageCreditOverrides: getGroupImageCreditOverrides(group.metadata),
    videoCreditOverrides: getGroupVideoCreditOverrides(group.metadata),
    videoCreditsPerItemOverrides: getGroupVideoCreditsPerItemOverrides(
      group.metadata
    ),
  };
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

  return createRuntimeBackendGroupSnapshot(group);
}

/**
 * 在一个数据库 statement 中读取完整视频计费依赖并固定可信分组。
 *
 * @param input - 已通过调用方鉴权边界交付的用户、可选 API Key 与分组选择。
 * @param database - 调用方的 execute 端口；任务创建传入当前事务，能力查询传入 db。
 * @returns 同一 PostgreSQL statement snapshot 中的 pinned 分组、双价格和能力配置上下文。
 * @sideEffects 仅执行一次参数化只读 SQL statement。
 * @failure API Key 绑定、分组、模式、价格或能力任一非法时 fail closed。
 */
export async function resolveAuthoritativeRuntimeVideoPricingContext(
  input: ResolveAuthoritativeRuntimeVideoPricingContextInput,
  database: RuntimeVideoQuoteTransactionDatabase
): Promise<AuthoritativeRuntimeVideoPricingContext> {
  const rows = z.array(authoritativeVideoQuoteRowSchema).parse(
    extractExecuteRows(
      await database.execute(sql`
        with selected_settings as (
          select key, value
          from system_setting
          where key in (
            ${"MODEL_MARKETPLACE_CONFIG"},
            ${"VIDEO_MODEL_CAPABILITY_OVERRIDES"},
            ${"VIDEO_MODEL_BILLING_MODES"},
            ${"VIDEO_MODEL_CREDITS_PER_SECOND"},
            ${"VIDEO_MODEL_CREDITS_PER_ITEM"}
          )
        ), api_key_binding as (
          select generation_group_id
          from external_api_key
          where id = ${input.apiKeyId ?? null}
            and user_id = ${input.userId}
            and is_active = true
          limit 1
        ), enabled_groups as (
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
        )
        select
          coalesce(
            (select jsonb_object_agg(key, value) from selected_settings),
            '{}'::jsonb
          ) as settings,
          exists(select 1 from api_key_binding) as api_key_found,
          (select generation_group_id from api_key_binding limit 1)
            as api_key_group_id,
          coalesce(
            (select jsonb_agg(to_jsonb(enabled_groups)) from enabled_groups),
            '[]'::jsonb
          ) as groups
      `)
    )
  );
  const row = rows[0];
  if (!row) {
    throw new Error("权威视频报价查询未返回快照");
  }

  const target = selectTrustedRuntimeGroupTarget(
    input,
    input.apiKeyId
      ? row.api_key_found
        ? { groupId: row.api_key_group_id }
        : undefined
      : undefined
  );
  const selectedGroup = selectRuntimeBackendGroupCandidate(row.groups, target);
  const group = createRuntimeBackendGroupSnapshot(selectedGroup);
  const marketplaceConfig = parseModelMarketplaceConfig(
    row.settings.MODEL_MARKETPLACE_CONFIG
  );
  const videoCapabilityOverrides = parseVideoModelCapabilityOverrides(
    row.settings.VIDEO_MODEL_CAPABILITY_OVERRIDES
  );
  const billing = normalizeVideoModelBillingSettings({
    billingModes: row.settings.VIDEO_MODEL_BILLING_MODES,
    creditsPerSecond: row.settings.VIDEO_MODEL_CREDITS_PER_SECOND,
    creditsPerItem: row.settings.VIDEO_MODEL_CREDITS_PER_ITEM,
    customModels: marketplaceConfig.customModels
      .filter((candidate) => candidate.category === "video")
      .map((candidate) => ({
        modelId: candidate.modelId,
        supportedResolutions: candidate.supportedResolutions,
      })),
  });

  return {
    pinnedGroupId: group.id,
    group,
    marketplaceConfig,
    videoCapabilityOverrides,
    billing,
  };
}

/**
 * 从同一权威上下文解析一个模型分辨率的严格报价。
 *
 * @param context - 已固定 Principal 分组、marketplace 与三项计费设置的上下文。
 * @param input - 目标真实模型、分辨率和用于计算总价的时长。
 * @returns 与任务快照核心同形的严格报价。
 * @sideEffects 无。
 * @throws 模型停用、模式缺失、分辨率或双矩阵非法时 fail closed。
 */
export function resolveRuntimeVideoQuoteFromContext(
  context: AuthoritativeRuntimeVideoPricingContext,
  input: Pick<
    ResolveAuthoritativeRuntimeVideoQuoteInput,
    "modelId" | "resolution" | "durationSeconds"
  >
): VideoBillingQuote {
  const modelId = normalizeRuntimeRequestedModelId({
    requestKind: "video",
    modelId: input.modelId,
  });
  if (!modelId) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "视频模型 ID 必须是全局目录中的真实模型 ID"
    );
  }
  if (
    !isModelMarketplaceModelEnabled(context.marketplaceConfig, "video", modelId)
  ) {
    throw new Error("视频模型已停用或不在当前模型配置中");
  }
  const customModel = context.marketplaceConfig.customModels.find(
    (candidate) =>
      candidate.category === "video" && candidate.modelId === modelId
  );
  const mode = context.billing.billingModes[modelId];
  if (!mode) {
    throw new Error("视频模型缺少统一计费模式");
  }
  return resolveVideoBillingQuote({
    modelId,
    ...(customModel
      ? { supportedResolutions: customModel.supportedResolutions }
      : {}),
    resolution: input.resolution,
    durationSeconds: input.durationSeconds,
    mode,
    globalCreditsPerSecond: context.billing.creditsPerSecond,
    globalCreditsPerItem: context.billing.creditsPerItem,
    groupCreditsPerSecond: context.group.videoCreditOverrides,
    groupCreditsPerItem: context.group.videoCreditsPerItemOverrides,
  });
}

/**
 * 在视频任务创建事务内一次读取并解析目标报价。
 *
 * @param input - Principal 分组事实与目标模型、分辨率、时长。
 * @param database - 当前创建事务 execute 端口。
 * @returns pinned 分组、严格报价以及创建能力快照复核所需上下文。
 * @sideEffects 执行一次参数化只读 SQL statement。
 * @throws 任一绑定、配置或报价事实非法时 fail closed。
 */
export async function resolveAuthoritativeRuntimeVideoQuote(
  input: ResolveAuthoritativeRuntimeVideoQuoteInput,
  database: RuntimeVideoQuoteTransactionDatabase
): Promise<AuthoritativeRuntimeVideoQuote> {
  const context = await resolveAuthoritativeRuntimeVideoPricingContext(
    input,
    database
  );
  return {
    pinnedGroupId: context.pinnedGroupId,
    group: context.group,
    quote: resolveRuntimeVideoQuoteFromContext(context, input),
    marketplaceConfig: context.marketplaceConfig,
    videoCapabilityOverrides: context.videoCapabilityOverrides,
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
 * 在不获取租约、不修改成员状态的前提下判断当前视频任务是否存在合格账号。
 *
 * @param input Principal 可信分组、真实模型和内容安全要求。
 * @returns 有空闲账号、仅容量已满或没有合格账号。
 * @sideEffects 只读 API Key 绑定、分组、成员配置和当前有效租约。
 * @failure 分组不可达或数据库事实非法时显式抛错，不把系统错误伪装成无账号。
 */
export async function inspectRuntimeVideoBackendAvailability(
  input: ListConfiguredRuntimeModelIdsInput & {
    modelId: string;
    requiresContentSafety: boolean;
    /** 自定义模型等 API-only 请求必须在只读预检时沿用同一成员类型约束。 */
    requiredMemberType?: "api" | "adobe";
  },
  dependencies?: {
    group?: RuntimeBackendGroupSnapshot;
    database?: RuntimeVideoBackendAvailabilityDatabase;
  }
): Promise<RuntimeBackendAvailability> {
  const group =
    dependencies?.group ?? (await resolveTrustedGroupSnapshot(input));
  const requiresContentSafety =
    input.requiresContentSafety && group.contentSafetyEnabled !== false;
  const database =
    dependencies?.database ?? (await import("@repo/database")).db;
  const rows = z.array(runtimeAvailabilityRowSchema).parse(
    extractExecuteRows(
      await database.execute(sql`
        with eligible as (
          select member.id, member.concurrency
          from image_backend_member as member
          inner join image_backend_member_group as membership
            on membership.member_id = member.id
          left join image_backend_member_api_config as api
            on api.member_id = member.id
          left join image_backend_member_api_adapter_version as api_version
            on api_version.id = api.current_adapter_version_id
            and api_version.member_id_snapshot = member.id
            and api_version.credential_scope = api.credential_scope
          left join image_backend_member_adobe_config as adobe
            on adobe.member_id = member.id
          where membership.group_id = ${group.id}
            and member.is_enabled = true
            and (${input.requiredMemberType ?? null}::text is null or member.type = ${
              input.requiredMemberType ?? null
            })
            and (member.cooldown_until is null or member.cooldown_until <= now())
            and member.status <> 'error'
            and not (
              member.type = 'adobe'
              and exists (
                select 1
                from adobe_credential_health as credential_health
                where credential_health.member_id = member.id
                  and credential_health.status = 'isolated'
              )
            )
            and exists (
              select 1
              from json_array_elements_text(member.supported_model_ids)
                as supported_model(model_id)
              where lower(trim(supported_model.model_id)) =
                lower(${input.modelId})
            )
            and (
              ${requiresContentSafety} = false
              or member.content_safety_enabled = true
            )
            and (
              (
                member.type = 'api'
                and api.api_key is not null
                and api_version.id is not null
              )
              or (
                member.type = 'adobe'
                and adobe.mode = 'direct'
                and adobe.cookie is not null
                and adobe.access_token is not null
              )
            )
        ), inflight as (
          select lease.member_id, count(*)::integer as count
          from image_backend_member_lease as lease
          inner join eligible on eligible.id = lease.member_id
          where lease.expires_at > now()
          group by lease.member_id
        )
        select
          count(*)::integer as eligible_count,
          count(*) filter (
            where coalesce(inflight.count, 0) < eligible.concurrency
          )::integer as available_count
        from eligible
        left join inflight on inflight.member_id = eligible.id
      `)
    )
  );
  const availability = rows[0];
  if (!availability || availability.eligible_count === 0) return "no_candidate";
  return availability.available_count > 0 ? "available" : "capacity_rejected";
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
  if (!row.api_key) throw new ApiVideoRecoveryConfigInvalidError();
  try {
    const adapter = apiUpstreamAdapterDraftSchema.parse(
      row.adapter_configuration
    );
    if (adapter.credentialScope !== row.credential_scope) {
      throw new ApiVideoRecoveryConfigInvalidError();
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
  } catch (error) {
    if (error instanceof ApiVideoRecoveryConfigInvalidError) throw error;
    // WHY：数据库读取异常发生在本 try 之前；这里只收敛已读取版本的 schema、
    // 凭据域和 URL 损坏，供遗留迁移区分永久快照缺失与临时基础设施异常。
    throw new ApiVideoRecoveryConfigInvalidError();
  }
}

/** 根据统一成员与类型配置表构造现有媒体适配器可消费的配置快照。 */
async function loadRuntimeBackendLease(
  acquisition: AcquiredBackendMemberLease,
  group: RuntimeBackendGroupSnapshot,
  input: CreateRuntimeBackendSessionInput
): Promise<RuntimeBackendLease> {
  const { db } = await import("@repo/database");
  const result = await db.execute(sql`
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
      `);
  let rows: z.output<typeof runtimeConfigRowSchema>[];
  try {
    rows = z.array(runtimeConfigRowSchema).parse(extractExecuteRows(result));
  } catch {
    throw new RuntimeBackendConfigurationInvalidError(
      "获租成员的运行时配置记录无效"
    );
  }
  const row = rows[0];
  if (!row) {
    throw new RuntimeBackendConfigurationInvalidError(
      "获租成员在加载运行时配置前已不存在"
    );
  }

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
      throw new RuntimeBackendConfigurationInvalidError(
        "API 成员缺少固定适配版本、地址或凭据"
      );
    }
    let adapter: z.output<typeof apiUpstreamAdapterDraftSchema>;
    try {
      adapter = apiUpstreamAdapterDraftSchema.parse(
        row.api_adapter_configuration
      );
      parseMediaUpstreamUrl(adapter.baseUrl);
    } catch {
      throw new RuntimeBackendConfigurationInvalidError(
        "API 成员固定适配版本无效"
      );
    }
    if (adapter.credentialScope !== row.api_credential_scope) {
      throw new RuntimeBackendConfigurationInvalidError(
        "API 成员当前凭据域与固定适配版本不一致"
      );
    }
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
    throw new RuntimeBackendConfigurationInvalidError(
      "Adobe 成员缺少运行时类型配置"
    );
  }
  if (row.adobe_mode === "gateway") {
    if (!row.adobe_base_url || !row.adobe_api_key) {
      throw new RuntimeBackendConfigurationInvalidError(
        "Adobe gateway 成员缺少地址或凭据"
      );
    }
    try {
      parseMediaUpstreamUrl(row.adobe_base_url);
    } catch {
      throw new RuntimeBackendConfigurationInvalidError(
        "Adobe gateway 成员地址无效"
      );
    }
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
      ...(normalizedInput.requiredMemberType
        ? { requiredMemberType: normalizedInput.requiredMemberType }
        : {}),
      ...(normalizedInput.requiredApiAdapterMemberId
        ? {
            requiredApiAdapterMemberId:
              normalizedInput.requiredApiAdapterMemberId,
          }
        : {}),
      ...(normalizedInput.requiredApiAdapterVersionId
        ? {
            requiredApiAdapterVersionId:
              normalizedInput.requiredApiAdapterVersionId,
          }
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
      if (classifyRuntimeBackendLeaseLoadFailure(error) === "retry_later") {
        // 数据库、模块加载等临时故障必须交给任务队列稍后重试；固定成员场景若
        // 排除当前成员递归重选，会被错误收敛成 no_eligible_member 并触发退款。
        throw error;
      }
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
