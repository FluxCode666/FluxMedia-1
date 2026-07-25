import { db } from "@repo/database";
import {
  externalApiKey,
  imageBackendAdobe,
  imageBackendAdobeGroup,
  imageBackendApi,
  imageBackendApiGroup,
  imageBackendGroup,
  imageBackendInflightLease,
  imageBackendParameterMappingTemplate,
  imageBackendSchedulerMetric,
  imageBackendStickyBinding,
} from "@repo/database/schema";
import {
  canAdobeBackendServeModel,
  collectAdvertisedAdobeImageModelIds,
  isAdobeImageFamilyModelId,
  normalizeAdobeEnabledModelIds,
  resolveAdobeImageModelId,
} from "@repo/shared/adobe/enabled-models";
import { isFireflyVideoModelId } from "@repo/shared/adobe/firefly-direct/video-catalog";
import {
  isPlanAtLeast,
  normalizeSubscriptionPlan,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import {
  getGroupImageCreditOverrides,
  getGroupVideoCreditOverrides,
  type ImageCreditOverrides,
} from "@repo/shared/image-backend/group-image-pricing";
import { validateNestedGroupConfig } from "@repo/shared/image-backend/nested-groups";
import {
  normalizeRequestParameterMappings,
  type RequestParameterMapping,
} from "@repo/shared/image-backend/request-parameter-mapping";
import {
  collectAdvertisedModelIds,
  normalizeSupportedModelIds,
  supportsRequestedModel,
} from "@repo/shared/image-backend/supported-models";
import { logWarn } from "@repo/shared/logger";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { getUserPlan } from "@repo/shared/subscription/services/user-plan";
import {
  getRuntimeSettingNumber,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  isContentSafetyRejection,
  USER_INPUT_LIMIT_PATTERNS,
} from "@/features/image-generation/sla-classification";
import type { ApiConfig } from "@/features/image-generation/types";

import {
  imageBackendApiInterfaceAllowsRequest,
  normalizeChatCompletionsUpstreamMode,
  normalizeImageBackendApiInterfaceMode,
  normalizeImagesUpstreamMode,
} from "./api-interface-mode";
import {
  checkImageBackendApiHealth,
  type ImageApiHealthResult,
} from "./health-check";
import {
  buildImageGenerationCatalogMemberGroupMap,
  buildImageGenerationModelCatalog,
  type ImageGenerationCatalogMember,
  type ImageGenerationModelCatalog,
  isImageGenerationCatalogMemberAvailable,
} from "./image-generation-model-catalog";
import type {
  ChatCompletionsUpstreamMode,
  ContentSafetyOverride,
  ImageBackendApiInterfaceMode,
  ImageBackendGroupBackendType,
  ImageBackendRequestKind,
  ImagesUpstreamMode,
} from "./types";

const IMAGE_BACKEND_INFLIGHT_LEASE_TTL_MS = 30 * 60_000;
const MAX_BACKEND_STALE_SELECTION_RETRIES = 100;
const STICKY_PREVIOUS_RESPONSE_TTL_MS = 24 * 60 * 60_000;
const STICKY_SESSION_TTL_MS = 60 * 60_000;

type BackendLeaseTx = Pick<
  typeof db,
  "delete" | "execute" | "insert" | "select" | "update"
>;

type BackendLeaseAcquireResult = "acquired" | "full" | "stale";

type ResolveBackendOptions = {
  userId: string;
  apiKeyId?: string;
  // 页面单次明确选择的分组。外部 API Key 绑定分组优先于它；未提供时沿用用户偏好/默认组。
  backendGroupId?: string;
  // 仅可信服务端在同一请求的重解析（例如换号重试、蒙版外绘）时传入：固定首次命中的
  // 隐式默认分组，避免管理员切换默认组后同一次请求跨组路由和错价。它不是用户输入，
  // 不能替代 backendGroupId，也不会触发手选分组的套餐或 isUserSelectable 校验。
  pinnedImplicitGroupId?: string;
  requestKind: ImageBackendRequestKind;
  // 请求的模型 ID。firefly-* 会将候选收敛到 Adobe 语义的后端；普通图像模型仍可由
  // API 与 Adobe 共同调度。标记 adobeSourced 的 API 后端也可参与 Firefly 请求。
  requestedModel?: string;
  preferredMemberId?: string;
  preferredMemberType?: "api" | "adobe";
  stickyPreviousResponseId?: string;
  stickySessionKey?: string;
  // 强制走 adobe（firefly）后端：与 requestedModel 为 firefly-* 前缀等价地把候选收敛到
  // 仅 adobe。供 force_firefly 请求标志使用（用户可对任意模型强制改用 adobe 出图）。
  forceFirefly?: boolean;
  // 蒙版不会被 Adobe 编辑适配器下传。为真时，候选集必须排除 pool-adobe。
  requiresMask?: boolean;
};

type StickyBindingMember = {
  type: "api" | "adobe";
  id: string;
  groupId?: string | null;
};

type SchedulerSelectionLayer =
  | "previous_response_id"
  | "session_hash"
  | "preferred"
  | "load_balance";

type PoolMember =
  | {
      type: "api";
      id: string;
      alwaysActive: boolean;
      groupId: string | null;
      groupIds: string[];
      groupMetadata: Record<string, unknown> | null;
      groupContentSafetyEnabled: boolean | null;
      name: string;
      baseUrl: string;
      apiKey: string;
      model: string | null;
      supportedModelIds: string[];
      interfaceMode: ImageBackendApiInterfaceMode;
      chatCompletionsUpstreamMode: ChatCompletionsUpstreamMode;
      imagesUpstreamMode: ImagesUpstreamMode;
      parameterMappings: RequestParameterMapping[];
      useStream: boolean;
      // Adobe 来源：上游实为 Adobe 的 gpt 格式 api。开启后参与 firefly 候选
      // （含反向转换）。
      adobeSourced: boolean;
      contentSafetyEnabled: boolean;
      priority: number;
      concurrency: number;
      leaseId?: string;
      leasePersisted?: boolean;
      leaseTouchedMember?: boolean;
      schedulerLayer?: SchedulerSelectionLayer;
      lastUsedAt: Date | null;
      lastAcquiredAt: Date | null;
      createdAt: Date;
      metadata: Record<string, unknown> | null;
    }
  | {
      // Adobe Firefly（adobe2api）后端成员。与 api 类似（baseUrl + apiKey），但请求/
      // 响应走 adobe 适配器（model id 编码宽高比/分辨率、产物为 URL 需 re-host）。
      type: "adobe";
      id: string;
      alwaysActive: boolean;
      groupId: string | null;
      groupIds: string[];
      groupMetadata: Record<string, unknown> | null;
      groupContentSafetyEnabled: boolean | null;
      name: string;
      // gateway：外部 adobe2api；direct：本仓库直连 Firefly。
      mode: string;
      baseUrl: string;
      apiKey: string;
      enabledModels: string[] | null;
      defaultRatio: string;
      defaultResolution: string;
      gptImageQuality: string;
      supportsVideo: boolean;
      contentSafetyEnabled: boolean;
      priority: number;
      concurrency: number;
      leaseId?: string;
      leasePersisted?: boolean;
      leaseTouchedMember?: boolean;
      schedulerLayer?: SchedulerSelectionLayer;
      lastUsedAt: Date | null;
      lastAcquiredAt: Date | null;
      createdAt: Date;
      metadata: Record<string, unknown> | null;
    };

export type ResolvedImageBackendPoolConfig = {
  config: ApiConfig;
  groupId: string | null;
  memberId: string;
  memberType: "api" | "adobe";
  contentSafetyEnabled: boolean;
  schedulerLayer?: SchedulerSelectionLayer;
};

export class ImageBackendPoolUnavailableError extends Error {
  constructor(message = "当前生图后端分组没有可用媒体后端") {
    super(message);
    this.name = "ImageBackendPoolUnavailableError";
  }
}

export type ImageBackendReportResultInput = {
  memberType?: "api" | "adobe";
  memberId?: string;
  success: boolean;
  error?: string | null;
  upstreamResetAt?: string | Date | null;
  retryAfterSeconds?: number | null;
  durationMs?: number | null;
};

export type ImageBackendReportResultOutcome = {
  success: boolean;
  status?: string;
  cooldownUntil?: Date | null;
  retryable: boolean;
  switchable: boolean;
};

type BackendSchedulerMetadata = {
  errorEwma?: number;
  durationMsEwma?: number;
  successStreak?: number;
  failStreak?: number;
  lastObservedAt?: string;
};

type ImageBackendGroupMetadata = Record<string, unknown> & {
  minPlan?: unknown;
  backendType?: unknown;
  childGroupIds?: unknown;
};

type SelectableGroupContext = {
  id: string;
  metadata: Record<string, unknown> | null;
  contentSafetyEnabled: boolean | null;
};

const DEFAULT_BACKEND_COOLDOWN_MINUTES = 15;
// 工具级限流(ChatGPT image_gen.text2im)默认冷却分钟:滚动限流恢复快,比通用兜底更短。
const DEFAULT_TOOL_RATE_LIMIT_COOLDOWN_MINUTES = 3;
const MAX_PARSED_RESET_COOLDOWN_DAYS = 14;
// 冷却地板:上游/源给的重置时间若过短(典型:per-min 429 的 "try again in 15ms"),
// 直接采纳会让冷却≈0、后端被立刻重选再撞限流。低于地板一律抬到地板。真·用量限制
// (5h/7d)重置远大于地板,不受影响。
const MIN_RESET_COOLDOWN_MS = 60_000;

// 健康度 EWMA 平滑系数:近期结果权重。0.4 比旧 0.2 反应快一倍——对账号"变差/恢复"
// 双向都更实时(一次失败即把 errorEwma 明显抬高、一次成功也更快回落),代价是轻微抖动,
// 由冷却(硬失败)与下方时间衰减共同兜底,可接受。
const BACKEND_SCHEDULER_EWMA_ALPHA = 0.4;
// 健康惩罚按"距上次观测时长"做指数衰减的半衰期(毫秒):age=半衰期时惩罚减半。
// 让久未观测的旧惩罚淡出,疑似已恢复或闲置的后端重新参与轮换、定期复探。
const BACKEND_HEALTH_PENALTY_HALF_LIFE_MS = 180_000;
const DEFAULT_UNRECOVERABLE_BACKEND_ERROR_KEYWORDS = [
  "refresh token",
  "invalid refresh token",
  "invalid_refresh_token",
  "invalid_grant",
  "authentication",
  "authentication failed",
  "token_invalidated",
  "token_revoked",
  "account deactivated",
  "deactivated account",
  "deactivated_workspace",
  "workspace deactivated",
  "organization has been disabled",
  "identity verification is required",
];
const backendInflight = new Map<string, number>();

export function resetImageBackendInflightForTests() {
  if (process.env.NODE_ENV === "test") {
    backendInflight.clear();
  }
}

function isMissingBackendLeaseTableError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "42P01" || message.includes("image_backend_inflight_lease");
}

function isMissingBackendStickyTableError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "42P01" || message.includes("image_backend_sticky_binding");
}

function isMissingBackendSchedulerMetricTableError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "42P01" || message.includes("image_backend_scheduler_metric");
}

function normalizeGroupBackendType(
  value?: unknown
): ImageBackendGroupBackendType {
  return value === "web" || value === "responses" ? value : "mixed";
}

// Adobe（Firefly）模型按前缀识别：firefly-* 会排除普通 API，仅保留
// Adobe 后端及 adobeSourced API 后端。普通图像模型仍允许 Adobe 参与同池调度。
function isAdobeFireflyModelId(model?: string | null): boolean {
  return (model || "").trim().toLowerCase().startsWith("firefly-");
}

/**
 * 判断 API 后端是否声明支持请求模型，并兼容 Adobe 家族的裸/Firefly 别名。
 *
 * API 后端的模型列表仍保持大小写无关的精确匹配；只有已知 Adobe 图像家族允许在
 * `nano-banana-pro` 与 `firefly-nano-banana-pro` 两种公开别名之间互认，避免普通自定义
 * 模型意外扩大能力范围。
 */
function supportsPoolApiRequestedModel(
  supportedModelIds: unknown,
  requestedModel?: string
): boolean {
  if (supportsRequestedModel(supportedModelIds, requestedModel)) return true;
  if (!isAdobeImageFamilyModelId(requestedModel)) return false;

  const canonicalModelId = resolveAdobeImageModelId(requestedModel);
  if (!canonicalModelId.startsWith("firefly-nano-banana")) return false;
  const bareModelId = canonicalModelId.slice("firefly-".length);
  return (
    supportsRequestedModel(supportedModelIds, canonicalModelId) ||
    supportsRequestedModel(supportedModelIds, bareModelId)
  );
}

/**
 * 判断图像请求是否只能由 API 池后端承接。
 *
 * Adobe 图像协议只支持平台已识别的 Firefly 模型；管理员配置的 API 后端才允许
 * 透传例如 nano-banana-*、grok-* 的上游模型标识。
 * 裸 nano-banana* 虽属于 API 可透传的自定义模型，但 Adobe 直连候选会单独放行，
 * 以兼容调用方不带 firefly- 前缀的请求。
 *
 * @param requestKind - 本次调用类型。
 * @param model - 客户端请求的模型。
 * @returns 未知图像模型需要只选择 API 池成员时返回 true。
 */
function requiresApiBackendForCustomImageModel(
  requestKind: ImageBackendRequestKind | undefined,
  model?: string | null
): boolean {
  if (requestKind !== "image_generation" && requestKind !== "image_edit") {
    return false;
  }
  const normalized = (model || "").trim().toLowerCase();
  return Boolean(
    normalized &&
      !normalized.startsWith("gpt-image-") &&
      !normalized.startsWith("firefly-")
  );
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function fromSafetyOverride(value: ContentSafetyOverride) {
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  return null;
}

function effectiveContentSafety(
  groupValue: boolean | null,
  memberValue: boolean
) {
  return groupValue ?? memberValue;
}

function asGroupMetadata(
  metadata: Record<string, unknown> | null | undefined
): ImageBackendGroupMetadata {
  return metadata && typeof metadata === "object" ? metadata : {};
}

/**
 * 删除旧计费倍率键，同时保留分组的其他扩展配置。
 *
 * @param metadata - 数据库中的分组 metadata。
 * @returns 不再包含任何历史计费倍率别名的新对象。
 */
function withoutLegacyGroupBillingMetadata(
  metadata: Record<string, unknown> | null | undefined
) {
  const normalized = { ...asGroupMetadata(metadata) };
  delete normalized.billingMultiplier;
  delete normalized.creditMultiplier;
  delete normalized.costMultiplier;
  return normalized;
}

function getGroupMinPlan(
  metadata: Record<string, unknown> | null | undefined
): SubscriptionPlan {
  return normalizeSubscriptionPlan(asGroupMetadata(metadata).minPlan, "free");
}

function getGroupBackendType(
  metadata: Record<string, unknown> | null | undefined
) {
  return normalizeGroupBackendType(asGroupMetadata(metadata).backendType);
}

function normalizeGroupChildGroupIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    )
  );
}

function getGroupChildGroupIds(
  metadata: Record<string, unknown> | null | undefined
) {
  return normalizeGroupChildGroupIds(asGroupMetadata(metadata).childGroupIds);
}

function normalizeMemberGroupIds(
  groupIds?: readonly (string | null | undefined)[] | null
) {
  if (!groupIds) return [];
  return Array.from(
    new Set(
      groupIds
        .map((groupId) => (typeof groupId === "string" ? groupId.trim() : ""))
        .filter((groupId) => groupId && groupId !== "default")
    )
  );
}

function memberGroupIdsFromInput(input: {
  groupId?: string | null;
  groupIds?: string[] | null;
}) {
  return input.groupIds !== undefined
    ? normalizeMemberGroupIds(input.groupIds)
    : normalizeMemberGroupIds(input.groupId ? [input.groupId] : []);
}

function groupBackendAllowsRequest(
  metadata: Record<string, unknown> | null | undefined,
  requestKind: ImageBackendRequestKind
) {
  const backendType = getGroupBackendType(metadata);
  if (requestKind === "responses") {
    return backendType === "responses" || backendType === "mixed";
  }
  return true;
}

function canUseBackendGroupForPlan(
  metadata: Record<string, unknown> | null | undefined,
  plan: SubscriptionPlan
) {
  return isPlanAtLeast(plan, getGroupMinPlan(metadata));
}

function memberTimestamp(value: Date | string | null | undefined) {
  if (!value) return 0;
  return new Date(value).getTime();
}

function healthBucket(member: PoolMember) {
  return Math.floor(backendHealthPenalty(member) * 100);
}

function parseDurationMs(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?\s*ms$/.test(trimmed)) {
    return Number.parseFloat(trimmed) || null;
  }
  if (/^\d+(?:\.\d+)?\s*s$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 1000;
  }
  if (/^\d+(?:\.\d+)?\s*m$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 60_000;
  }
  if (/^\d+(?:\.\d+)?\s*h$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 60 * 60_000;
  }
  if (/^\d+(?:\.\d+)?\s*d(?:ay|ays)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed) * 24 * 60 * 60_000;
  }
  const parts = [
    ...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|day|days)/g),
  ];
  if (!parts.length) return null;
  const total = parts.reduce((sum, match) => {
    const amount = Number.parseFloat(match[1] || "0");
    const unit = match[2];
    if (unit === "ms") return sum + amount;
    if (unit === "s") return sum + amount * 1000;
    if (unit === "m") return sum + amount * 60_000;
    if (unit === "h") return sum + amount * 60 * 60_000;
    if (unit === "d" || unit === "day" || unit === "days") {
      return sum + amount * 24 * 60 * 60_000;
    }
    return sum;
  }, 0);
  return total > 0 ? total : null;
}

function backendKey(member: Pick<PoolMember, "type" | "id">) {
  return `${member.type}:${member.id}`;
}

function stickyScope(layer: "previous_response_id" | "session_hash") {
  return layer;
}

function normalizeStickyBindingMember(
  value: StickyBindingMember | undefined
): StickyBindingMember | undefined {
  if (!value?.id) return undefined;
  return {
    type: value.type,
    id: value.id,
    groupId: value.groupId ?? null,
  };
}

export async function bindImageBackendStickyMember(input: {
  layer: "previous_response_id" | "session_hash";
  key?: string | null;
  member?: StickyBindingMember;
  ttlMs?: number;
  metadata?: Record<string, unknown> | null;
}) {
  const key = input.key?.trim();
  const member = normalizeStickyBindingMember(input.member);
  if (!key || !member) return;
  const now = new Date();
  const ttlMs =
    input.ttlMs ??
    (input.layer === "previous_response_id"
      ? STICKY_PREVIOUS_RESPONSE_TTL_MS
      : STICKY_SESSION_TTL_MS);
  const expiresAt = new Date(now.getTime() + Math.max(60_000, ttlMs));
  try {
    await db
      .insert(imageBackendStickyBinding)
      .values({
        id: nanoid(),
        scope: stickyScope(input.layer),
        bindingKey: key,
        memberType: member.type,
        memberId: member.id,
        groupId: member.groupId ?? null,
        accountBackend: null,
        expiresAt,
        metadata: input.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          imageBackendStickyBinding.scope,
          imageBackendStickyBinding.bindingKey,
        ],
        set: {
          memberType: member.type,
          memberId: member.id,
          groupId: member.groupId ?? null,
          accountBackend: null,
          expiresAt,
          metadata: input.metadata ?? null,
          updatedAt: now,
        },
      });
  } catch (error) {
    if (isMissingBackendStickyTableError(error)) return;
    logWarn("写入生图后端粘性映射失败", {
      layer: input.layer,
      memberType: member.type,
      memberId: member.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveStickyBinding(input: {
  layer: "previous_response_id" | "session_hash";
  key?: string | null;
}): Promise<StickyBindingMember | null> {
  const key = input.key?.trim();
  if (!key) return null;
  const now = new Date();
  try {
    const [row] = await db
      .select({
        memberType: imageBackendStickyBinding.memberType,
        memberId: imageBackendStickyBinding.memberId,
        groupId: imageBackendStickyBinding.groupId,
      })
      .from(imageBackendStickyBinding)
      .where(
        and(
          eq(imageBackendStickyBinding.scope, stickyScope(input.layer)),
          eq(imageBackendStickyBinding.bindingKey, key),
          gt(imageBackendStickyBinding.expiresAt, now)
        )
      )
      .limit(1);
    if (!row) return null;
    const member = normalizeStickyBindingMember({
      type: row.memberType === "adobe" ? "adobe" : "api",
      id: row.memberId,
      groupId: row.groupId,
    });
    if (!member) return null;
    await db
      .update(imageBackendStickyBinding)
      .set({
        lastHitAt: now,
        hitCount: sql`${imageBackendStickyBinding.hitCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(imageBackendStickyBinding.scope, stickyScope(input.layer)),
          eq(imageBackendStickyBinding.bindingKey, key)
        )
      );
    return member;
  } catch (error) {
    if (isMissingBackendStickyTableError(error)) return null;
    logWarn("读取生图后端粘性映射失败", {
      layer: input.layer,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function schedulerMetricBucket(date = new Date()) {
  const bucket = new Date(date);
  bucket.setMinutes(0, 0, 0);
  return bucket;
}

async function recordSchedulerMetric(input: {
  requestKind?: ImageBackendRequestKind;
  layer: SchedulerSelectionLayer | "switch";
  memberType?: "api" | "adobe" | null;
  memberId?: string | null;
  groupId?: string | null;
  candidateCount?: number;
  latencyMs?: number;
  switchCount?: number;
}) {
  const now = new Date();
  const requestKind = input.requestKind || "image_generation";
  const selectedLayer = input.layer;
  const stickyPreviousHitCount =
    selectedLayer === "previous_response_id" ? 1 : 0;
  const stickySessionHitCount = selectedLayer === "session_hash" ? 1 : 0;
  const loadBalanceCount = selectedLayer === "load_balance" ? 1 : 0;
  const switchCount = Math.max(0, Math.trunc(input.switchCount || 0));
  const selectCount = selectedLayer === "switch" ? 0 : 1;
  const candidateCount = Math.max(0, Math.trunc(input.candidateCount || 0));
  const latencyMs = Math.max(0, Math.trunc(input.latencyMs || 0));
  const memberType = input.memberType ?? "";
  const memberId = input.memberId ?? "";
  const groupId = input.groupId ?? "";
  try {
    await db
      .insert(imageBackendSchedulerMetric)
      .values({
        id: nanoid(),
        bucketStartedAt: schedulerMetricBucket(now),
        requestKind,
        selectedLayer,
        memberType,
        memberId,
        groupId,
        selectCount,
        stickyPreviousHitCount,
        stickySessionHitCount,
        loadBalanceCount,
        switchCount,
        candidateCountTotal: candidateCount,
        latencyMsTotal: latencyMs,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          imageBackendSchedulerMetric.bucketStartedAt,
          imageBackendSchedulerMetric.requestKind,
          imageBackendSchedulerMetric.selectedLayer,
          imageBackendSchedulerMetric.memberType,
          imageBackendSchedulerMetric.memberId,
          imageBackendSchedulerMetric.groupId,
        ],
        set: {
          selectCount: sql`${imageBackendSchedulerMetric.selectCount} + ${selectCount}`,
          stickyPreviousHitCount: sql`${imageBackendSchedulerMetric.stickyPreviousHitCount} + ${stickyPreviousHitCount}`,
          stickySessionHitCount: sql`${imageBackendSchedulerMetric.stickySessionHitCount} + ${stickySessionHitCount}`,
          loadBalanceCount: sql`${imageBackendSchedulerMetric.loadBalanceCount} + ${loadBalanceCount}`,
          switchCount: sql`${imageBackendSchedulerMetric.switchCount} + ${switchCount}`,
          candidateCountTotal: sql`${imageBackendSchedulerMetric.candidateCountTotal} + ${candidateCount}`,
          latencyMsTotal: sql`${imageBackendSchedulerMetric.latencyMsTotal} + ${latencyMs}`,
          updatedAt: now,
        },
      });
  } catch (error) {
    if (isMissingBackendSchedulerMetricTableError(error)) return;
    logWarn("记录生图后端调度指标失败", {
      requestKind,
      selectedLayer,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recordImageBackendSchedulerSwitch(input: {
  requestKind?: ImageBackendRequestKind;
  memberType?: "api" | "adobe" | null;
  memberId?: string | null;
  groupId?: string | null;
}) {
  await recordSchedulerMetric({
    ...input,
    layer: "switch",
    switchCount: 1,
  });
}

function backendInflightCount(member: Pick<PoolMember, "type" | "id">) {
  return backendInflight.get(backendKey(member)) || 0;
}

function backendConcurrency(member: Pick<PoolMember, "concurrency">) {
  return Math.max(1, Math.floor(member.concurrency || 1));
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSchedulerMetadata(
  metadata: Record<string, unknown> | null | undefined
): BackendSchedulerMetadata {
  const raw =
    metadata && typeof metadata.scheduler === "object" && metadata.scheduler
      ? (metadata.scheduler as Record<string, unknown>)
      : {};
  const errorEwma = finiteNumber(raw.errorEwma);
  const durationMsEwma = finiteNumber(raw.durationMsEwma);
  const successStreak = finiteNumber(raw.successStreak);
  const failStreak = finiteNumber(raw.failStreak);
  return {
    ...(errorEwma !== null
      ? { errorEwma: Math.max(0, Math.min(1, errorEwma)) }
      : {}),
    ...(durationMsEwma !== null
      ? { durationMsEwma: Math.max(0, durationMsEwma) }
      : {}),
    ...(successStreak !== null
      ? { successStreak: Math.max(0, Math.trunc(successStreak)) }
      : {}),
    ...(failStreak !== null
      ? { failStreak: Math.max(0, Math.trunc(failStreak)) }
      : {}),
    ...(typeof raw.lastObservedAt === "string"
      ? { lastObservedAt: raw.lastObservedAt }
      : {}),
  };
}

function ewma(previous: number | undefined, sample: number) {
  if (previous === undefined || !Number.isFinite(previous)) return sample;
  return (
    previous * (1 - BACKEND_SCHEDULER_EWMA_ALPHA) +
    sample * BACKEND_SCHEDULER_EWMA_ALPHA
  );
}

function nextSchedulerMetadataAfterResult(
  metadata: Record<string, unknown> | null | undefined,
  input: Pick<ImageBackendReportResultInput, "success" | "durationMs">,
  now: Date
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...metadata }
      : {};
  const previous = normalizeSchedulerMetadata(base);
  const durationMs =
    typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? Math.max(0, input.durationMs)
      : undefined;
  const next: BackendSchedulerMetadata = {
    errorEwma: ewma(previous.errorEwma, input.success ? 0 : 1),
    successStreak: input.success ? (previous.successStreak || 0) + 1 : 0,
    failStreak: input.success ? 0 : (previous.failStreak || 0) + 1,
    lastObservedAt: now.toISOString(),
    ...(durationMs !== undefined
      ? { durationMsEwma: ewma(previous.durationMsEwma, durationMs) }
      : previous.durationMsEwma !== undefined
        ? { durationMsEwma: previous.durationMsEwma }
        : {}),
  };
  return {
    ...base,
    scheduler: next,
  };
}

// 按距上次观测的时长对惩罚做指数衰减:刚观测(age≈0)≈1 全额;久未观测逐步趋 0。
// 无 lastObservedAt(从未观测)或时间异常时不衰减(返回 1),保持旧行为。
function recencyDecay(lastObservedAt: string | undefined) {
  if (!lastObservedAt) return 1;
  const observedMs = new Date(lastObservedAt).getTime();
  if (!Number.isFinite(observedMs)) return 1;
  const ageMs = Date.now() - observedMs;
  if (ageMs <= 0) return 1;
  return 0.5 ** (ageMs / BACKEND_HEALTH_PENALTY_HALF_LIFE_MS);
}

function backendHealthPenalty(member: PoolMember) {
  const scheduler = normalizeSchedulerMetadata(member.metadata);
  const errorPenalty = (scheduler.errorEwma || 0) * 100;
  const durationMs = scheduler.durationMsEwma || 0;
  const durationPenalty = Math.min(25, durationMs / 10_000);
  const failStreakPenalty = Math.min(20, (scheduler.failStreak || 0) * 3);
  const successRecovery = Math.min(8, (scheduler.successStreak || 0) * 0.5);
  const raw =
    errorPenalty + durationPenalty + failStreakPenalty - successRecovery;
  // 实时性:刚失败的号全额计入惩罚(立即降级);久未观测的旧惩罚指数淡出,让疑似已
  // 恢复/闲置的号重新进轮换、定期复探,评分反映"当前"而非"陈年"状态。
  return raw * recencyDecay(scheduler.lastObservedAt);
}

function hasBackendCapacity(member: PoolMember) {
  return backendInflightCount(member) < backendConcurrency(member);
}

function sameMemberTimestamp(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined
) {
  return memberTimestamp(left) === memberTimestamp(right);
}

async function pruneExpiredBackendLeases(
  tx: BackendLeaseTx,
  member: Pick<PoolMember, "type" | "id">,
  now: Date
) {
  await tx
    .delete(imageBackendInflightLease)
    .where(
      and(
        eq(imageBackendInflightLease.memberType, member.type),
        eq(imageBackendInflightLease.memberId, member.id),
        lt(imageBackendInflightLease.expiresAt, now)
      )
    );
}

async function acquirePoolMemberInflightLease(
  member: PoolMember,
  options?: { enforceLastAcquiredSnapshot?: boolean }
): Promise<BackendLeaseAcquireResult> {
  if (!hasBackendCapacity(member)) return "full";
  const leaseId = nanoid();
  let persisted = false;
  let touchedMember = false;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + IMAGE_BACKEND_INFLIGHT_LEASE_TTL_MS
  );
  if (typeof db.transaction !== "function") {
    acquireImageBackendInflight({
      memberType: member.type,
      memberId: member.id,
    });
    member.leaseId = leaseId;
    member.leasePersisted = false;
    member.leaseTouchedMember = false;
    return "acquired";
  }

  try {
    const acquired = await db.transaction(async (tx) => {
      let lockedLastAcquiredAt: Date | string | null | undefined;
      if (member.type === "api") {
        const [locked] = await tx
          .select({ lastAcquiredAt: imageBackendApi.lastAcquiredAt })
          .from(imageBackendApi)
          .where(eq(imageBackendApi.id, member.id))
          .for("update");
        lockedLastAcquiredAt = locked?.lastAcquiredAt;
        if (!locked) return "full";
        if (
          options?.enforceLastAcquiredSnapshot &&
          !sameMemberTimestamp(lockedLastAcquiredAt, member.lastAcquiredAt)
        ) {
          return "stale";
        }
      } else {
        const [locked] = await tx
          .select({ lastAcquiredAt: imageBackendAdobe.lastAcquiredAt })
          .from(imageBackendAdobe)
          .where(eq(imageBackendAdobe.id, member.id))
          .for("update");
        lockedLastAcquiredAt = locked?.lastAcquiredAt;
        if (!locked) return "full";
        if (
          options?.enforceLastAcquiredSnapshot &&
          !sameMemberTimestamp(lockedLastAcquiredAt, member.lastAcquiredAt)
        ) {
          return "stale";
        }
      }
      await pruneExpiredBackendLeases(tx, member, now);
      const [activeLeaseCount] = await tx
        .select({ value: count() })
        .from(imageBackendInflightLease)
        .where(
          and(
            eq(imageBackendInflightLease.memberType, member.type),
            eq(imageBackendInflightLease.memberId, member.id),
            gt(imageBackendInflightLease.expiresAt, now)
          )
        );
      const activeCount = Number(activeLeaseCount?.value || 0);
      if (activeCount >= backendConcurrency(member)) return "full";
      await tx.insert(imageBackendInflightLease).values({
        id: leaseId,
        memberType: member.type,
        memberId: member.id,
        expiresAt,
        createdAt: now,
      });
      if (member.type === "api") {
        await tx
          .update(imageBackendApi)
          .set({
            status: "active",
            cooldownUntil: null,
            lastUsedAt: now,
            lastAcquiredAt: now,
            updatedAt: now,
          })
          .where(eq(imageBackendApi.id, member.id));
      } else {
        await tx
          .update(imageBackendAdobe)
          .set({
            status: "active",
            cooldownUntil: null,
            lastUsedAt: now,
            lastAcquiredAt: now,
            updatedAt: now,
          })
          .where(eq(imageBackendAdobe.id, member.id));
      }
      touchedMember = true;
      persisted = true;
      return "acquired";
    });
    if (acquired === "acquired") {
      acquireImageBackendInflight({
        memberType: member.type,
        memberId: member.id,
      });
      member.leaseId = leaseId;
      member.leasePersisted = persisted;
      member.leaseTouchedMember = touchedMember;
      member.lastAcquiredAt = now;
      member.lastUsedAt = now;
    }
    return acquired;
  } catch (error) {
    if (isMissingBackendLeaseTableError(error)) {
      logWarn("生图后端并发租约表不存在，退回进程内并发控制", {
        memberType: member.type,
        memberId: member.id,
      });
    } else {
      logWarn("生图后端并发租约获取失败", {
        memberType: member.type,
        memberId: member.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  acquireImageBackendInflight({
    memberType: member.type,
    memberId: member.id,
  });
  member.leaseId = leaseId;
  member.leasePersisted = false;
  member.leaseTouchedMember = false;
  return "acquired";
}

function splitKeywordList(value?: string | null) {
  return (value || "")
    .split(/[\n,;，；]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

async function getUnrecoverableBackendErrorKeywords() {
  const configured = await getRuntimeSettingString(
    "IMAGE_BACKEND_UNRECOVERABLE_ERROR_KEYWORDS"
  );
  const keywords = splitKeywordList(configured);
  return keywords.length
    ? keywords
    : DEFAULT_UNRECOVERABLE_BACKEND_ERROR_KEYWORDS;
}

async function isUnrecoverableBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  if (!normalized) return false;
  const keywords = await getUnrecoverableBackendErrorKeywords();
  return keywords.some((keyword) => normalized.includes(keyword));
}

export function acquireImageBackendInflight(input: {
  memberType?: "api" | "adobe";
  memberId?: string;
}) {
  if (!input.memberType || !input.memberId) return;
  const key = `${input.memberType}:${input.memberId}`;
  backendInflight.set(key, (backendInflight.get(key) || 0) + 1);
}

export function releaseImageBackendInflight(input: {
  memberType?: "api" | "adobe";
  memberId?: string;
}) {
  if (!input.memberType || !input.memberId) return;
  const key = `${input.memberType}:${input.memberId}`;
  const current = backendInflight.get(key) || 0;
  if (current <= 1) {
    backendInflight.delete(key);
    return;
  }
  backendInflight.set(key, current - 1);
}

export async function releaseImageBackendInflightLease(input: {
  memberType?: "api" | "adobe";
  memberId?: string;
  leaseId?: string | null;
  leasePersisted?: boolean | null;
}) {
  releaseImageBackendInflight(input);
  if (!input.leaseId || input.leasePersisted !== true) return;
  try {
    await db
      .delete(imageBackendInflightLease)
      .where(eq(imageBackendInflightLease.id, input.leaseId));
  } catch (error) {
    logWarn("生图后端并发租约释放失败", {
      memberType: input.memberType,
      memberId: input.memberId,
      leaseId: input.leaseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isRecoverableBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    isUnsupportedModelBackendError(error) ||
    isTransientNetworkBackendError(error) ||
    isToolRateLimitBackendError(error) ||
    normalized.includes("429") ||
    normalized.includes("529") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("usage limit") ||
    normalized.includes("usage_limit") ||
    normalized.includes("limit has been reached") ||
    normalized.includes("limit_reached") ||
    normalized.includes("rate_limit_exceeded") ||
    normalized.includes("no available image quota") ||
    normalized.includes("quota exhausted") ||
    normalized.includes("quota_exhausted") ||
    normalized.includes("daily quota exceeded") ||
    normalized.includes("account quota exceeded") ||
    normalized.includes("quota has been exceeded") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("quota_exceeded") ||
    normalized.includes("insufficient_quota") ||
    normalized.includes("insufficient credit") ||
    normalized.includes("insufficient credits") ||
    normalized.includes("not enough credit") ||
    normalized.includes("not enough credits") ||
    normalized.includes("credit exhausted") ||
    normalized.includes("credits exhausted") ||
    normalized.includes("resource has been exhausted") ||
    normalized.includes("minimumcreditamountforusage") ||
    normalized.includes("minimum credit amount for usage") ||
    normalized.includes("minimum credit") ||
    normalized.includes("billing_hard_limit") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econnreset") ||
    normalized.includes("fetch failed") ||
    normalized.includes("empty non-json") ||
    normalized.includes("empty response") ||
    normalized.includes("non-json responses api response") ||
    normalized.includes("non-json images api response") ||
    normalized.includes("upstream returned no image output") ||
    normalized.includes("returned no image output") ||
    normalized.includes("api returned no image data") ||
    normalized.includes("http 500") ||
    normalized.includes("status_code=500") ||
    normalized.includes("status code 500") ||
    normalized.includes('"status":500') ||
    normalized.includes("internal server error") ||
    normalized.includes("server_error") ||
    normalized.includes("something seems to have gone wrong") ||
    normalized.includes("an error occurred while processing your request") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    normalized.includes("server overloaded") ||
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("temporary unavailable") ||
    normalized.includes("service unavailable") ||
    // 我方算 token 下载图片因 429/限流/超时/5xx 失败属瞬时，可切后端重试。
    (isTokenCountDownloadFailure(normalized) &&
      isTransientFileDownloadFailure(normalized))
  );
}

function isTransientNetworkBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized === "terminated" ||
    normalized.includes("typeerror: terminated") ||
    normalized.includes("request aborted") ||
    normalized.includes("operation was aborted") ||
    normalized.includes("socket closed") ||
    normalized.includes("socket hang up") ||
    normalized.includes("other side closed") ||
    normalized.includes("connection closed") ||
    normalized.includes("connection terminated") ||
    normalized.includes("connection reset") ||
    normalized.includes("econnreset") ||
    (normalized.includes("undici") && normalized.includes("terminated"))
  );
}

function isLocalAbortTimeoutError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("operation was aborted") &&
    normalized.includes("timeout")
  );
}

/**
 * 识别"上游模型缺少 image_generation 工具 / 不具备出图能力"导致只回文字的错误。
 *
 * WHY 单列：这类响应往往以"抱歉…我无法…"开头，会被内容安全拒绝启发式
 * （isApologyRefusal）误判为"用户内容被拒"，从而既不切换后端、也不惩罚后端，
 * 导致请求当场失败、坏后端长期留在轮换里。但它本质是后端配错（模型没有图像
 * 工具 / 环境未提供该工具），应当：可切换到别的后端 + 把该后端标记为 error。
 *
 * 为避免误伤"真正的内容拒绝"（如「图像生成请求被系统拒绝」），要求同时命中
 * "image_generation 工具 / 图像生成工具"字样与"未提供/不可用"语义。
 *
 * @param error 上游或本站包装后的错误文本。
 * @returns 是否为"后端缺少出图能力"类错误。
 */
export function isMissingImageToolBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  const mentionsImageTool =
    normalized.includes("图像生成工具") ||
    (normalized.includes("image_generation") &&
      (normalized.includes("工具") || normalized.includes("tool")));
  if (!mentionsImageTool) return false;
  return (
    normalized.includes("未提供") ||
    normalized.includes("没有提供") ||
    normalized.includes("没有可调用") ||
    normalized.includes("未提供可调用") ||
    normalized.includes("无法调用") ||
    normalized.includes("不可用") ||
    normalized.includes("不支持") ||
    normalized.includes("not available") ||
    normalized.includes("isn't available") ||
    normalized.includes("is not available") ||
    normalized.includes("not provided") ||
    normalized.includes("not enabled") ||
    normalized.includes("does not have") ||
    normalized.includes("doesn't have") ||
    normalized.includes("no image_generation") ||
    normalized.includes("unavailable")
  );
}

/**
 * 识别"中转本身坏掉/不可用"的确定性错误，按用户判定升级为 error（粘性下线）。
 *
 * - "没有可用token"：中转无上游额度或令牌。
 * - "html response body"：端点返回 HTML（源站宕机/网关错误页/baseUrl 配错），
 *   非 OpenAI 兼容 JSON。
 * - "service temporarily unavailable"：中转上游 502/服务不可用（典型
 *   "Upstream service temporarily unavailable"）。按运维要求标 error 踢出轮换（持续不可用
 *   的中转不自愈），由测活/重新启用复活；当次请求仍换号重试（文案含 502/temporarily
 *   unavailable，被 isRecoverableBackendError 判为可切换）。
 * 这类不会自愈，应踢出轮换直到管理员处理（测活/重新启用/常驻）。
 * 注意副作用：firefly-* / nano-banana 仅由 Adobe / adobe_sourced 后端出图，若这些后端因本
 * 错误被全部踢出，firefly 请求将无后端可解析——此时由 getEffectiveConfig 给出「无可用 Adobe
 * 后端」的明确报错（而非泛化的"默认后端缺失"），便于运维定位是后端被踢空而非模型问题。
 */
function isDeadRelayBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("没有可用token") ||
    normalized.includes("没有可用 token") ||
    normalized.includes("html response body") ||
    normalized.includes("service temporarily unavailable")
  );
}

// "failed to download file" 专指我方（如上游 new-api 为算 token）下载图片失败，
// 与 "error while downloading file"（上游下载用户提供的 url）区分：
// 后者是用户链接问题（终态、不切换），前者若是 429/超时/5xx 则属瞬时、可切后端。
function isTokenCountDownloadFailure(normalized: string) {
  return normalized.includes("failed to download file");
}

// 文件下载失败是否属于瞬时/可重试原因（429/限流/超时/5xx），而非客户端坏链接。
function isTransientFileDownloadFailure(normalized: string) {
  return (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    /status code:\s*5\d\d/.test(normalized)
  );
}

/**
 * 识别"该后端/分组未开通图像生成"(HTTP 403 permission_error)的确定性坏配置错误。
 * 不会自愈，应可切换到别的后端 + 把该后端标记为 error 踢出轮换，
 * 等管理员开通/测活后再启用，避免请求一直被路由到坏后端而当场失败。
 */
export function isImageGenDisabledBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("image generation is not enabled") ||
    normalized.includes("image_generation is not enabled") ||
    (normalized.includes("permission_error") &&
      normalized.includes("image generation"))
  );
}

/**
 * 识别"API Key 所属分组被上游停用"(HTTP 403 GROUP_DISABLED)的确定性坏配置错误。
 *
 * WHY 单列：中转把整组 Key 停用后，该后端的一切请求都会 403 且不会自愈。
 * 2026-06-10 事故：该文案不命中任何白名单 → 不切换当场失败，叠加 always_active
 * 不下线，形成"持续吃流量、每次都失败"的黑洞。应当：可切换到别的后端 +
 * 把该后端标记为 error 踢出轮换，等管理员处理(测活/重新启用)后再回来。
 */
export function isGroupDisabledBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("group_disabled") ||
    normalized.includes("分组已停用") ||
    normalized.includes("分组已禁用")
  );
}

function isUserRequestBackendError(error?: string | null) {
  // 缺图像工具是后端能力问题（非用户内容拒绝）：放行去走"可切换 + 标记 error"，
  // 否则会被下方 isApologyRefusal 误判成用户拒绝而当场失败、不切换。
  if (isMissingImageToolBackendError(error)) return false;
  const normalized = (error || "").toLowerCase();
  return (
    isContentSafetyRejection(error) ||
    normalized.includes("moderation_blocked") ||
    normalized.includes("image_generation_user_error") ||
    normalized.includes("user_error") ||
    normalized.includes("content_policy") ||
    normalized.includes("policy_violation") ||
    // 用户输入超限(提示词过长 / 参考图超数 / 输入图过大):切后端也救不了 → 不重试、直接报。
    // 与 SLA 侧共用 USER_INPUT_LIMIT_PATTERNS(sla-classification.ts),码 + 中英文案兜底,避免
    // 两处分类器漂移;限流类(rate limit/concurrency/too many requests)不在表内,仍可切换。
    USER_INPUT_LIMIT_PATTERNS.some((pattern) => normalized.includes(pattern)) ||
    normalized.includes(
      "the image data you provided does not represent a valid image"
    ) ||
    normalized.includes("error while downloading file") ||
    normalized.includes("unable to download content from the provided url") ||
    normalized.includes("file urls cannot be larger than") ||
    normalized.includes("transparent background is not supported") ||
    // 分辨率/尺寸不对（用户给的 size/分辨率/蒙版尺寸不符）：切后端也救不了，算用户错。
    normalized.includes("unsupported size") ||
    normalized.includes("invalid size") ||
    normalized.includes("size is not supported") ||
    normalized.includes("size not supported") ||
    normalized.includes("invalid resolution") ||
    normalized.includes("unsupported resolution") ||
    normalized.includes("resolution is not supported") ||
    normalized.includes("invalid dimensions") ||
    normalized.includes("unsupported dimensions") ||
    normalized.includes("does not match image size") ||
    normalized.includes("invalid_mask_image_format") ||
    // 无效图像（用户提供的图片本身无法识别/格式不对）：同理算用户错。
    normalized.includes("not a valid image") ||
    normalized.includes("invalid image data") ||
    normalized.includes("invalid image format") ||
    normalized.includes("unsupported image format") ||
    // 我方为算 token 下载图片失败（failed to download file）默认算用户错（坏链接/非图片/403/404），
    // 但若是 429/限流/超时/5xx 等瞬时原因（典型：上游为算 token 下载我方图片被限流），
    // 不算用户错，放行给 isRecoverableBackendError 走"切后端 + 冷却"。
    (isTokenCountDownloadFailure(normalized) &&
      !isTransientFileDownloadFailure(normalized))
  );
}

export function isImageBackendSwitchableError(error?: string | null) {
  return Boolean(
    error &&
      !isUserRequestBackendError(error) &&
      !isLocalAbortTimeoutError(error) &&
      (isRecoverableBackendError(error) ||
        isInvalidBackendCredentialError(error) ||
        isImageGenDisabledBackendError(error) ||
        isGroupDisabledBackendError(error))
  );
}

/**
 * 识别"未被任何已知规则记录"的未知后端错误：非用户请求错误、非本地超时
 * abort，也不命中任何可切换白名单。
 *
 * WHY 单列：isImageBackendSwitchableError 是白名单制，首次出现的新形态平台
 * 错误(上游新增的错误文案)默认不可切换，会当场失败砸在用户头上(GROUP_DISABLED
 * 事故即此类)。重试循环对这类错误允许有限次切换后端兜底，见
 * image-generation/service.ts 的 retryPoolBackendResult。
 */
export function isUnclassifiedBackendError(error?: string | null) {
  return Boolean(
    error &&
      !isUserRequestBackendError(error) &&
      !isLocalAbortTimeoutError(error) &&
      !isImageBackendSwitchableError(error)
  );
}

function isClassifiedFailureRecoverable(
  error: string | null,
  failure: { status?: string; cooldownUntil?: Date | null }
) {
  return Boolean(
    error &&
      !isUserRequestBackendError(error) &&
      isRecoverableBackendError(error) &&
      failure.status !== "error"
  );
}

function isInvalidBackendCredentialError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("401") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("invalid api key") ||
    normalized.includes("invalid_api_key") ||
    normalized.includes("invalid access token") ||
    normalized.includes("invalid_access_token") ||
    normalized.includes("invalid auth") ||
    normalized.includes("invalid authentication") ||
    normalized.includes("authentication token has been invalidated") ||
    normalized.includes("token has been invalidated") ||
    normalized.includes("token expired") ||
    normalized.includes("expired token") ||
    normalized.includes("token is expired") ||
    normalized.includes("access token expired") ||
    normalized.includes("signing in again") ||
    normalized.includes("please sign in again") ||
    normalized.includes("please try signing in again")
  );
}

function isUsageLimitBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("usage limit") ||
    normalized.includes("usage_limit") ||
    normalized.includes("limit has been reached") ||
    normalized.includes("limit_reached") ||
    normalized.includes("no available image quota") ||
    normalized.includes("quota exhausted") ||
    normalized.includes("quota_exhausted") ||
    normalized.includes("daily quota exceeded") ||
    normalized.includes("account quota exceeded") ||
    normalized.includes("insufficient_quota") ||
    normalized.includes("quota has been exceeded") ||
    normalized.includes("quota exceeded") ||
    normalized.includes("quota_exceeded") ||
    normalized.includes("insufficient credit") ||
    normalized.includes("insufficient credits") ||
    normalized.includes("not enough credit") ||
    normalized.includes("not enough credits") ||
    normalized.includes("credit exhausted") ||
    normalized.includes("credits exhausted") ||
    normalized.includes("resource has been exhausted") ||
    normalized.includes("minimumcreditamountforusage") ||
    normalized.includes("minimum credit amount for usage") ||
    normalized.includes("minimum credit") ||
    normalized.includes("billing_hard_limit")
  );
}

/**
 * 识别上游图像工具的 `image_gen.text2im` 工具级 RateLimitException。
 *
 * WHY 单列:部分 Responses 上游在图像额度用满时不会返回图片,而是回一条
 * `ChatGPTAgentToolRateLimitException`。这类滚动限流恢复快,必须按限流处理，不能被当成
 * 通用 "no image output" 落进 15 分钟临时桶,也利于 SLA 把它归类为限流而非平台故障。
 * "ratelimitexception"(小写)即可命中 ChatGPTAgentToolRateLimitException。
 */
function isToolRateLimitBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("ratelimitexception") ||
    (normalized.includes("image_gen.text2im") &&
      (normalized.includes("right now") || normalized.includes("rate limit")))
  );
}

function isOverloadBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("529") ||
    normalized.includes("overloaded") ||
    normalized.includes("server overloaded") ||
    normalized.includes("http 500") ||
    normalized.includes("status_code=500") ||
    normalized.includes("status code 500") ||
    normalized.includes('"status":500') ||
    normalized.includes("internal server error") ||
    normalized.includes("server_error") ||
    normalized.includes("something seems to have gone wrong") ||
    normalized.includes("an error occurred while processing your request") ||
    normalized.includes("empty non-json") ||
    normalized.includes("empty response") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("temporary unavailable") ||
    normalized.includes("service unavailable") ||
    normalized.includes("capacity") ||
    normalized.includes("try again later")
  );
}

function isUnsupportedModelBackendError(error?: string | null) {
  const normalized = (error || "").toLowerCase();
  return (
    normalized.includes("unsupported model") ||
    normalized.includes("model not supported") ||
    normalized.includes("model is not supported") ||
    normalized.includes("model_not_supported") ||
    normalized.includes("unsupported_model") ||
    normalized.includes("model_not_found") ||
    normalized.includes("model_not_available") ||
    normalized.includes("does not support this model") ||
    normalized.includes("not support this model") ||
    normalized.includes("tool choice 'image_generation' not found") ||
    normalized.includes("tool choice image_generation not found") ||
    (normalized.includes("image_generation") &&
      normalized.includes("not found in") &&
      normalized.includes("tools")) ||
    normalized.includes("not allowed to use model") ||
    normalized.includes("not have access to the model") ||
    normalized.includes("account does not support") ||
    normalized.includes("账户不支持此模型") ||
    normalized.includes("不支持此模型") ||
    normalized.includes("不支持该模型")
  );
}

function parseDateValue(value: string | Date | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const durationMs = parseDurationMs(trimmed);
  if (durationMs) {
    return new Date(Date.now() + durationMs);
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampResetDate(date: Date | null, now: Date) {
  if (!date || date.getTime() <= now.getTime()) return null;
  // 地板:亚秒级/过短的上游重置抬到至少 MIN_RESET_COOLDOWN_MS,避免冷却形同虚设。
  const min = now.getTime() + MIN_RESET_COOLDOWN_MS;
  const max = now.getTime() + MAX_PARSED_RESET_COOLDOWN_DAYS * 24 * 60 * 60_000;
  return new Date(Math.min(Math.max(date.getTime(), min), max));
}

function parseResetDateFromError(error?: string | null) {
  if (!error) return null;
  const normalized = error.replace(/\\"/g, '"');
  const retryAfter = normalized.match(/retry-after["'\s:=]+(\d{1,8})/i)?.[1];
  if (retryAfter) {
    return new Date(Date.now() + Number(retryAfter) * 1000);
  }
  const retryAfterSeconds = normalized.match(
    /(?:retryAfterSeconds|retry_after_seconds|retry_after|retryAfter|reset_after_seconds|resets_in_seconds|quotaResetDelay)["'\s:=]+([^"',}\]\s]+)/i
  )?.[1];
  if (retryAfterSeconds) {
    const numeric = Number(retryAfterSeconds);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(Date.now() + numeric * 1000);
    }
    const durationMs = parseDurationMs(retryAfterSeconds);
    if (durationMs) return new Date(Date.now() + durationMs);
  }

  const relativeResetMatch = normalized.match(
    /(?:reset_after|resetAfter|restore_after|restoreAfter)["'\s:=]+([^"',}\]\s]+)/i
  )?.[1];
  if (relativeResetMatch) {
    const numeric = Number(relativeResetMatch);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(Date.now() + numeric * 1000);
    }
    const durationMs = parseDurationMs(relativeResetMatch);
    if (durationMs) return new Date(Date.now() + durationMs);
  }

  const resetMatch = normalized.match(
    /(?:x-ratelimit-reset(?:-[a-z0-9_-]+)?|upstreamResetAt|upstream_reset_at|resetAt|reset_at|resetsAt|resets_at|restore_at|restoreAt)["'\s:=]+([^"',}\]\s]+)/i
  )?.[1];
  if (resetMatch) {
    const parsed = parseDateValue(resetMatch);
    if (parsed) return parsed;
  }

  const proseMatch = normalized.match(
    /(?:reset|resets|restore|available again|try again)(?:\s+\w+){0,4}\s+(?:at|after|on|in)[:\s]+([^"',}\]\n]+)/i
  )?.[1];
  return parseDateValue(proseMatch);
}

function resolveCooldownDate(
  error: string | null,
  fallback: Date | null,
  input?: Pick<
    ImageBackendReportResultInput,
    "upstreamResetAt" | "retryAfterSeconds"
  >,
  options?: { useUpstreamReset?: boolean }
) {
  if (!options?.useUpstreamReset) return fallback;

  const now = new Date();
  const retryAfter = Number(input?.retryAfterSeconds);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    const parsed = clampResetDate(
      new Date(now.getTime() + retryAfter * 1000),
      now
    );
    if (parsed) return parsed;
  }
  const explicitReset = clampResetDate(
    parseDateValue(input?.upstreamResetAt),
    now
  );
  if (explicitReset) return explicitReset;
  const bodyReset = clampResetDate(parseResetDateFromError(error), now);
  if (bodyReset) return bodyReset;
  return fallback;
}

function cooldownFromMinutes(minutes: number) {
  return new Date(Date.now() + Math.max(1, minutes) * 60_000);
}

async function getBackendCooldownMinutes(
  key:
    | "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_RATE_LIMIT_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_TOOL_RATE_LIMIT_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_OVERLOAD_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_USAGE_LIMIT_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_UNSUPPORTED_MODEL_COOLDOWN_MINUTES"
    | "IMAGE_BACKEND_TEMPORARY_ERROR_COOLDOWN_MINUTES"
) {
  const defaultMinutes = await getRuntimeSettingNumber(
    "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES",
    DEFAULT_BACKEND_COOLDOWN_MINUTES,
    { positive: true }
  );
  if (key === "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES") {
    return defaultMinutes;
  }
  // 工具级限流恢复快,未配置时用比通用兜底更短的默认值(3 分钟),而非沿用 15 分钟兜底。
  const keyFallback =
    key === "IMAGE_BACKEND_TOOL_RATE_LIMIT_COOLDOWN_MINUTES"
      ? DEFAULT_TOOL_RATE_LIMIT_COOLDOWN_MINUTES
      : defaultMinutes;
  return await getRuntimeSettingNumber(key, keyFallback, { positive: true });
}

export async function classifyFailure(
  error?: string | null,
  input?: Pick<
    ImageBackendReportResultInput,
    "upstreamResetAt" | "retryAfterSeconds"
  >
): Promise<{
  status?: string;
  cooldownUntil?: Date | null;
}> {
  const normalized = (error || "").toLowerCase();
  if (isUserRequestBackendError(error)) {
    return {};
  }
  // 后端缺少出图能力（只回文字/无 image_generation 工具）：标记 error 踢出轮换，
  // 与 isImageBackendSwitchableError 配合实现"本次切换到别的后端 + 后续不再选它"。
  if (isMissingImageToolBackendError(error)) {
    return { status: "error", cooldownUntil: null };
  }
  // 中转坏掉（无 token / 返回 HTML）：确定性不可用，按用户判定升级为 error 踢出。
  if (isDeadRelayBackendError(error)) {
    return { status: "error", cooldownUntil: null };
  }
  // 该后端/分组未开通图像生成(403 permission)：确定性坏配置，标记 error 踢出轮换。
  if (isImageGenDisabledBackendError(error)) {
    return { status: "error", cooldownUntil: null };
  }
  // API Key 所属分组被上游停用(403 GROUP_DISABLED)：确定性坏配置，标记 error 踢出轮换。
  if (isGroupDisabledBackendError(error)) {
    return { status: "error", cooldownUntil: null };
  }
  if (
    (await isUnrecoverableBackendError(error)) ||
    isInvalidBackendCredentialError(error)
  ) {
    return { status: "error", cooldownUntil: null };
  }
  // ChatGPT 画图工具级限流(image_gen.text2im / ChatGPTAgentToolRateLimitException):
  // 工具级滚动限流恢复快，按 limited 与独立短冷却处理；上游 reset 时间优先。
  // 上游若给出 reset 时间则优先。仍属可切换错误(见 isRecoverableBackendError),换号重试。
  // 放在 usage-limit 之前:即便文案同时带通用 "limit" 字样,也走 3 分钟工具桶而非 15 分钟额度桶。
  if (isToolRateLimitBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_TOOL_RATE_LIMIT_COOLDOWN_MINUTES"
    );
    return {
      status: "limited",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input,
        { useUpstreamReset: true }
      ),
    };
  }
  if (isUsageLimitBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_USAGE_LIMIT_COOLDOWN_MINUTES"
    );
    return {
      status: "limited",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input,
        { useUpstreamReset: true }
      ),
    };
  }
  if (isUnsupportedModelBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_UNSUPPORTED_MODEL_COOLDOWN_MINUTES"
    );
    return {
      status: "active",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input
      ),
    };
  }
  if (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests")
  ) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_RATE_LIMIT_COOLDOWN_MINUTES"
    );
    return {
      status: "active",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input,
        { useUpstreamReset: true }
      ),
    };
  }
  if (isOverloadBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_OVERLOAD_COOLDOWN_MINUTES"
    );
    return {
      status: "active",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input
      ),
    };
  }
  if (isRecoverableBackendError(error)) {
    const minutes = await getBackendCooldownMinutes(
      "IMAGE_BACKEND_TEMPORARY_ERROR_COOLDOWN_MINUTES"
    );
    return {
      status: "active",
      cooldownUntil: resolveCooldownDate(
        error || null,
        cooldownFromMinutes(minutes),
        input
      ),
    };
  }
  const minutes = await getBackendCooldownMinutes(
    "IMAGE_BACKEND_DEFAULT_COOLDOWN_MINUTES"
  );
  return {
    status: "active",
    cooldownUntil: cooldownFromMinutes(minutes),
  };
}

/**
 * 把分类结果按"该后端是否启用失败冷却"收敛。
 *
 * API 与 Adobe 后端由各自的 `failureCooldownEnabled` 决定：关闭时丢弃一切
 * 冷却或限流结果，仅保留确定性 `error`（不可恢复、
 * 凭证废/缺图像工具/中转坏）。
 */
function resolveEffectiveFailureForMember(
  failure: {
    status?: string;
    cooldownUntil?: Date | null;
  },
  apiFailureCooldownEnabled: boolean
) {
  if (apiFailureCooldownEnabled) {
    return failure;
  }
  return {
    status: failure.status === "error" ? failure.status : undefined,
    cooldownUntil:
      failure.status === "error" ? failure.cooldownUntil : undefined,
  };
}

// always_active（遇错常驻）的失败处置：常驻后端遇【任何】失败都不自动下线——返回空对象
// 表示"不改 status、不进冷却，仅由调用方记 lastError/failCount"。含 502/HTML、dead-relay、
// 凭证/分组等终态错误：运营勾了"遇错常驻"即要求它永不被自动标 error 踢出。
// WHY 含终态：曾经只豁免临时错误、对 status='error' 仍踢出，导致常驻 relay 撞到
// 「HTTP 502: HTML response body」这类 dead-relay 错误被标 error 踢空，进而触发「没有可用的
// 默认生图后端」。代价：真·死号会持续被选中、每次浪费一次尝试后换号，需人工停用——这是
// "常驻"语义的固有取舍，由运营自行承担。非常驻后端不走此函数，按 classifyFailure 的判定
// （临时冷却 / status='error' 粘性踢出）。
export function resolveAlwaysActiveFailure(
  alwaysActive: boolean,
  effectiveFailure: { status?: string; cooldownUntil?: Date | null }
): { status?: string; cooldownUntil?: Date | null } {
  return alwaysActive ? {} : effectiveFailure;
}

function isBackendAvailableStatus(
  statusColumn: typeof imageBackendApi.status | typeof imageBackendAdobe.status,
  cooldownColumn:
    | typeof imageBackendApi.cooldownUntil
    | typeof imageBackendAdobe.cooldownUntil,
  now: Date
) {
  return or(
    eq(statusColumn, "active"),
    and(eq(statusColumn, "limited"), sql`${cooldownColumn} <= ${now}`)
  );
}

function truncateError(value?: string | null) {
  if (!value) return null;
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

async function getDefaultGroupId() {
  const [defaultGroup] = await db
    .select({ id: imageBackendGroup.id })
    .from(imageBackendGroup)
    .where(
      and(
        eq(imageBackendGroup.isEnabled, true),
        eq(imageBackendGroup.isDefault, true)
      )
    )
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt))
    .limit(1);

  if (defaultGroup) return defaultGroup.id;

  const [firstGroup] = await db
    .select({ id: imageBackendGroup.id })
    .from(imageBackendGroup)
    .where(eq(imageBackendGroup.isEnabled, true))
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt))
    .limit(1);

  return firstGroup?.id ?? null;
}

type ResolvedRequestedGroup = {
  groupId: string | null;
  explicit: boolean;
  pinnedImplicit: boolean;
};

/**
 * 判断本次解析是否可使用服务端固定的隐式默认分组。
 *
 * @param options - 调度入参，可能同时带 API Key 或用户显式分组。
 * @returns 候选固定组 ID；绑定分组的 API Key 会在读取绑定后覆盖该候选值。
 * @remarks 该值只由服务端从同一次请求的首次解析结果派生，绝不能透传客户端请求。
 */
function getPinnedImplicitGroupId(options: ResolveBackendOptions) {
  if (options.backendGroupId?.trim()) return null;
  return options.pinnedImplicitGroupId?.trim() || null;
}

/**
 * 解析本次请求的目标分组及其路由语义。
 *
 * @param options - 调度入参。
 * @param plan - 当前用户套餐，用于验证用户显式分组及组的最低套餐。
 * @returns 目标分组、是否为用户/API Key 显式路由、是否为服务端固定的隐式路由。
 * @remarks 固定隐式路由仍需在后续 ensureGroupUsable 中检查启用和套餐资格，但不能被
 * 手选分组能力或 isUserSelectable 限制影响。
 */
async function resolveRequestedGroup(
  options: ResolveBackendOptions,
  plan: SubscriptionPlan
): Promise<ResolvedRequestedGroup> {
  if (options.apiKeyId) {
    const [key] = await db
      .select({ groupId: externalApiKey.generationGroupId })
      .from(externalApiKey)
      .where(eq(externalApiKey.id, options.apiKeyId))
      .limit(1);
    if (key?.groupId) {
      return {
        groupId: key.groupId,
        explicit: true,
        pinnedImplicit: false,
      };
    }
    const pinnedImplicitGroupId = getPinnedImplicitGroupId(options);
    if (pinnedImplicitGroupId) {
      return {
        groupId: pinnedImplicitGroupId,
        explicit: false,
        pinnedImplicit: true,
      };
    }
    return {
      groupId: await getDefaultGroupId(),
      explicit: false,
      pinnedImplicit: false,
    };
  }

  const backendGroupId = options.backendGroupId?.trim();
  if (backendGroupId) {
    if (!(await canUsePlanCapability(plan, "backendGroups.select"))) {
      throw new ImageBackendPoolUnavailableError(
        "当前套餐不支持手动选择生图分组"
      );
    }

    const group = await ensureGroupUsable(backendGroupId, plan);
    // WHY: 前端目录仅用于展示；请求到达调度器时必须按当前启用状态、套餐与可选资格
    // 重新校验，避免旧页面、篡改请求或管理员刚调整配置后静默路由到其他分组。
    if (
      !group ||
      group.id !== backendGroupId ||
      !group.isEnabled ||
      !group.isUserSelectable
    ) {
      throw new ImageBackendPoolUnavailableError(
        "所选生图分组不可用、不可手动选择或当前套餐不可用"
      );
    }

    return {
      groupId: group.id,
      explicit: true,
      pinnedImplicit: false,
    };
  }

  const pinnedImplicitGroupId = getPinnedImplicitGroupId(options);
  if (pinnedImplicitGroupId) {
    return {
      groupId: pinnedImplicitGroupId,
      explicit: false,
      pinnedImplicit: true,
    };
  }

  return {
    groupId: await getDefaultGroupId(),
    explicit: false,
    pinnedImplicit: false,
  };
}

async function ensureGroupUsable(
  groupId: string | null,
  plan: SubscriptionPlan
) {
  if (!groupId) return null;
  const [group] = await db
    .select()
    .from(imageBackendGroup)
    .where(
      and(
        eq(imageBackendGroup.id, groupId),
        eq(imageBackendGroup.isEnabled, true)
      )
    )
    .limit(1);
  if (group && !canUseBackendGroupForPlan(group.metadata, plan)) {
    return null;
  }
  return group ?? null;
}

async function listSelectableGroupContexts(
  group: {
    id: string;
    metadata: Record<string, unknown> | null;
    contentSafetyEnabled: boolean | null;
  },
  plan: SubscriptionPlan,
  requestKind: ImageBackendRequestKind
): Promise<SelectableGroupContext[]> {
  const contexts: SelectableGroupContext[] = [
    {
      id: group.id,
      metadata: group.metadata,
      contentSafetyEnabled: group.contentSafetyEnabled,
    },
  ];
  if (getGroupBackendType(group.metadata) !== "mixed") return contexts;

  const childGroupIds = getGroupChildGroupIds(group.metadata).filter(
    (childGroupId) => childGroupId !== group.id
  );
  if (!childGroupIds.length) return contexts;

  const childGroups = await db
    .select({
      id: imageBackendGroup.id,
      metadata: imageBackendGroup.metadata,
      contentSafetyEnabled: imageBackendGroup.contentSafetyEnabled,
    })
    .from(imageBackendGroup)
    .where(
      and(
        inArray(imageBackendGroup.id, childGroupIds),
        eq(imageBackendGroup.isEnabled, true)
      )
    );
  const childGroupMap = new Map(childGroups.map((child) => [child.id, child]));

  for (const childGroupId of childGroupIds) {
    const child = childGroupMap.get(childGroupId);
    if (!child) continue;
    if (!canUseBackendGroupForPlan(child.metadata, plan)) continue;
    if (getGroupBackendType(child.metadata) === "mixed") continue;
    if (getGroupChildGroupIds(child.metadata).length) continue;
    if (!groupBackendAllowsRequest(child.metadata, requestKind)) continue;
    contexts.push({
      id: child.id,
      metadata: child.metadata,
      contentSafetyEnabled: child.contentSafetyEnabled,
    });
  }

  return contexts;
}

async function selectPoolMember(
  groupId: string | null,
  groupMetadata?: Record<string, unknown> | null,
  groupContentSafetyEnabled?: boolean | null,
  groupContexts?: SelectableGroupContext[],
  requestKind?: ImageBackendRequestKind,
  excluded?: Set<string>,
  preferredMemberId?: string,
  preferredMemberType?: "api" | "adobe",
  stickyPreviousMember?: StickyBindingMember | null,
  stickySessionMember?: StickyBindingMember | null,
  requestedModel?: string,
  forceFirefly = false,
  requiresMask = false,
  staleRetryCount = 0
): Promise<PoolMember | null> {
  // fireflyOnly：候选收敛到 Adobe 语义后端的触发——显式 force_firefly、Firefly 图像前缀，
  // 或完整/裸 Veo/Kling 视频模型。普通 API 不参与；图像 firefly 请求仍允许
  // adobeSourced API 共同调度，视频则只允许 Adobe direct。
  const fireflyOnly =
    forceFirefly ||
    isAdobeFireflyModelId(requestedModel) ||
    isFireflyVideoModelId(requestedModel);
  const apiOnlyCustomImageModel = requiresApiBackendForCustomImageModel(
    requestKind,
    requestedModel
  );
  const selectionStartedAt = Date.now();
  const contexts = groupContexts?.length
    ? groupContexts
    : groupId
      ? [
          {
            id: groupId,
            metadata: groupMetadata ?? null,
            contentSafetyEnabled: groupContentSafetyEnabled ?? null,
          },
        ]
      : [];
  const contextMap = new Map(contexts.map((context) => [context.id, context]));
  const groupIds = contexts.map((context) => context.id);
  const now = new Date();
  const apiBaseWhere = and(
    eq(imageBackendApi.isEnabled, true),
    // always_active 的 API 无视 cooldown 与临时故障始终入选,但 status="error"（终态）仍踢出
    // 轮换。其余维持原"健康且未冷却"判定。
    or(
      and(
        eq(imageBackendApi.alwaysActive, true),
        sql`${imageBackendApi.status} <> 'error'`
      ),
      and(
        isBackendAvailableStatus(
          imageBackendApi.status,
          imageBackendApi.cooldownUntil,
          now
        ),
        or(
          sql`${imageBackendApi.cooldownUntil} IS NULL`,
          sql`${imageBackendApi.cooldownUntil} <= ${now}`
        )
      )
    )
  );
  // groupIds 命中时经 imageBackendApiGroup join 取出该 API 所属的全部分组，
  // matchedGroupId 为本次命中的分组（供下游分组上下文解析）；未指定分组时退回
  // 主分组 groupId（matchedGroupId 直接取自 imageBackendApi.groupId）。
  const apiRowsPromise = groupIds.length
    ? db
        .select({
          matchedGroupId: imageBackendApiGroup.groupId,
          id: imageBackendApi.id,
          alwaysActive: imageBackendApi.alwaysActive,
          groupId: imageBackendApi.groupId,
          name: imageBackendApi.name,
          baseUrl: imageBackendApi.baseUrl,
          apiKey: imageBackendApi.apiKey,
          model: imageBackendApi.model,
          supportedModelIds: imageBackendApi.supportedModelIds,
          interfaceMode: imageBackendApi.interfaceMode,
          chatCompletionsUpstreamMode:
            imageBackendApi.chatCompletionsUpstreamMode,
          imageUpstreamMode: imageBackendApi.imageUpstreamMode,
          parameterMappings: imageBackendApi.parameterMappings,
          useStream: imageBackendApi.useStream,
          adobeSourced: imageBackendApi.adobeSourced,
          contentSafetyEnabled: imageBackendApi.contentSafetyEnabled,
          priority: imageBackendApi.priority,
          concurrency: imageBackendApi.concurrency,
          lastUsedAt: imageBackendApi.lastUsedAt,
          lastAcquiredAt: imageBackendApi.lastAcquiredAt,
          createdAt: imageBackendApi.createdAt,
          metadata: imageBackendApi.metadata,
        })
        .from(imageBackendApi)
        .innerJoin(
          imageBackendApiGroup,
          eq(imageBackendApiGroup.apiId, imageBackendApi.id)
        )
        .where(
          and(apiBaseWhere, inArray(imageBackendApiGroup.groupId, groupIds))
        )
        .orderBy(
          asc(imageBackendApi.priority),
          asc(imageBackendApi.lastUsedAt),
          asc(imageBackendApi.createdAt)
        )
    : db
        .select({
          matchedGroupId: imageBackendApi.groupId,
          id: imageBackendApi.id,
          alwaysActive: imageBackendApi.alwaysActive,
          groupId: imageBackendApi.groupId,
          name: imageBackendApi.name,
          baseUrl: imageBackendApi.baseUrl,
          apiKey: imageBackendApi.apiKey,
          model: imageBackendApi.model,
          supportedModelIds: imageBackendApi.supportedModelIds,
          interfaceMode: imageBackendApi.interfaceMode,
          chatCompletionsUpstreamMode:
            imageBackendApi.chatCompletionsUpstreamMode,
          imageUpstreamMode: imageBackendApi.imageUpstreamMode,
          parameterMappings: imageBackendApi.parameterMappings,
          useStream: imageBackendApi.useStream,
          adobeSourced: imageBackendApi.adobeSourced,
          contentSafetyEnabled: imageBackendApi.contentSafetyEnabled,
          priority: imageBackendApi.priority,
          concurrency: imageBackendApi.concurrency,
          lastUsedAt: imageBackendApi.lastUsedAt,
          lastAcquiredAt: imageBackendApi.lastAcquiredAt,
          createdAt: imageBackendApi.createdAt,
          metadata: imageBackendApi.metadata,
        })
        .from(imageBackendApi)
        .where(
          and(
            apiBaseWhere,
            groupId ? eq(imageBackendApi.groupId, groupId) : sql`true`
          )
        )
        .orderBy(
          asc(imageBackendApi.priority),
          asc(imageBackendApi.lastUsedAt),
          asc(imageBackendApi.createdAt)
        );

  // adobe（Firefly）候选：与 api 同构的入选条件（always_active 仅豁免临时故障，
  // status="error" 终态仍踢出）。
  const adobeBaseWhere = and(
    eq(imageBackendAdobe.isEnabled, true),
    or(
      and(
        eq(imageBackendAdobe.alwaysActive, true),
        sql`${imageBackendAdobe.status} <> 'error'`
      ),
      and(
        isBackendAvailableStatus(
          imageBackendAdobe.status,
          imageBackendAdobe.cooldownUntil,
          now
        ),
        or(
          sql`${imageBackendAdobe.cooldownUntil} IS NULL`,
          sql`${imageBackendAdobe.cooldownUntil} <= ${now}`
        )
      )
    )
  );
  const adobeSelection = {
    matchedGroupId: imageBackendAdobe.groupId,
    id: imageBackendAdobe.id,
    alwaysActive: imageBackendAdobe.alwaysActive,
    groupId: imageBackendAdobe.groupId,
    name: imageBackendAdobe.name,
    mode: imageBackendAdobe.mode,
    baseUrl: imageBackendAdobe.baseUrl,
    apiKey: imageBackendAdobe.apiKey,
    enabledModels: imageBackendAdobe.enabledModels,
    defaultRatio: imageBackendAdobe.defaultRatio,
    defaultResolution: imageBackendAdobe.defaultResolution,
    gptImageQuality: imageBackendAdobe.gptImageQuality,
    supportsVideo: imageBackendAdobe.supportsVideo,
    contentSafetyEnabled: imageBackendAdobe.contentSafetyEnabled,
    priority: imageBackendAdobe.priority,
    concurrency: imageBackendAdobe.concurrency,
    lastUsedAt: imageBackendAdobe.lastUsedAt,
    lastAcquiredAt: imageBackendAdobe.lastAcquiredAt,
    createdAt: imageBackendAdobe.createdAt,
    metadata: imageBackendAdobe.metadata,
  };
  // Adobe 按分组归属参与调度：只从
  // 本次请求命中的分组拉取 adobe 后端，不再全局忽略分组。挂低优先级即天然成为兜底。
  const adobeRowsPromise = groupIds.length
    ? db
        .select({
          ...adobeSelection,
          matchedGroupId: imageBackendAdobeGroup.groupId,
        })
        .from(imageBackendAdobe)
        .innerJoin(
          imageBackendAdobeGroup,
          eq(imageBackendAdobeGroup.adobeId, imageBackendAdobe.id)
        )
        .where(
          and(adobeBaseWhere, inArray(imageBackendAdobeGroup.groupId, groupIds))
        )
        .orderBy(
          asc(imageBackendAdobe.priority),
          asc(imageBackendAdobe.lastUsedAt),
          asc(imageBackendAdobe.createdAt)
        )
    : db
        .select(adobeSelection)
        .from(imageBackendAdobe)
        .where(
          and(
            adobeBaseWhere,
            groupId ? eq(imageBackendAdobe.groupId, groupId) : sql`true`
          )
        )
        .orderBy(
          asc(imageBackendAdobe.priority),
          asc(imageBackendAdobe.lastUsedAt),
          asc(imageBackendAdobe.createdAt)
        );

  const [apiRows, adobeRows] = await Promise.all([
    apiRowsPromise,
    adobeRowsPromise,
  ]);

  const apiMembers: PoolMember[] = apiRows
    .filter((row) => {
      const matchedGroupId = row.matchedGroupId || row.groupId;
      const context = matchedGroupId ? contextMap.get(matchedGroupId) : null;
      const metadata = context?.metadata ?? groupMetadata;
      const effectiveRequestKind = requestKind || "image_generation";
      return (
        // fireflyOnly（force_firefly、firefly-* 或视频模型）时通用 API 不参与；图像的
        // 「Adobe 来源」api 仍可参与，视频因当前 operation 只支持 direct 必须排除。
        (!fireflyOnly ||
          (row.adobeSourced && !isFireflyVideoModelId(requestedModel))) &&
        groupBackendAllowsRequest(metadata, effectiveRequestKind) &&
        imageBackendApiInterfaceAllowsRequest(
          row.interfaceMode,
          effectiveRequestKind,
          row.imageUpstreamMode
        ) &&
        // 配置非空时，支持模型列表是供应商能力边界；空列表保留历史"不限制"语义，
        // 避免迁移后把所有既有 API 后端突然排除出调度。
        supportsPoolApiRequestedModel(row.supportedModelIds, requestedModel)
      );
    })
    .map((row) => {
      const matchedGroupId = row.matchedGroupId || row.groupId;
      const context = matchedGroupId ? contextMap.get(matchedGroupId) : null;
      return {
        type: "api",
        id: row.id,
        alwaysActive: row.alwaysActive,
        groupId: matchedGroupId,
        groupIds: normalizeMemberGroupIds([row.groupId, row.matchedGroupId]),
        groupMetadata: context?.metadata ?? groupMetadata ?? null,
        groupContentSafetyEnabled:
          context?.contentSafetyEnabled ?? groupContentSafetyEnabled ?? null,
        name: row.name,
        baseUrl: row.baseUrl,
        apiKey: row.apiKey,
        model: row.model,
        supportedModelIds: normalizeSupportedModelIds(row.supportedModelIds),
        interfaceMode: normalizeImageBackendApiInterfaceMode(row.interfaceMode),
        chatCompletionsUpstreamMode: normalizeChatCompletionsUpstreamMode(
          row.chatCompletionsUpstreamMode
        ),
        imagesUpstreamMode: normalizeImagesUpstreamMode(row.imageUpstreamMode),
        parameterMappings: normalizeRequestParameterMappings(
          row.parameterMappings
        ),
        useStream: row.useStream,
        adobeSourced: row.adobeSourced,
        contentSafetyEnabled: row.contentSafetyEnabled,
        priority: row.priority,
        concurrency: row.concurrency,
        lastUsedAt: row.lastUsedAt,
        lastAcquiredAt: row.lastAcquiredAt,
        createdAt: row.createdAt,
        metadata: row.metadata,
      };
    });

  // adobe 成员：作为特殊 Firefly 成员，对图像生成/编辑及视频请求始终参与候选（无论
  // fireflyOnly 与否），按 priority 与 API 同池排序——管理员把 Adobe 优先级调低即
  // 天然成为兜底。图像 fireflyOnly 时 adobeSourced API 仍可竞争；视频只允许 direct。
  const adobeMembers: PoolMember[] = adobeRows
    .filter((row) => {
      const matchedGroupId = row.matchedGroupId || row.groupId;
      const context = matchedGroupId ? contextMap.get(matchedGroupId) : null;
      const metadata = context?.metadata ?? groupMetadata;
      const effectiveRequestKind = requestKind || "image_generation";
      return (
        // 裸 nano-banana* 虽属于 API-only 自定义模型，但已知 Adobe 模型例外允许
        // pool-adobe 参与，和 pool-api 按 priority 同池竞争。
        (!apiOnlyCustomImageModel ||
          isAdobeImageFamilyModelId(requestedModel) ||
          isFireflyVideoModelId(requestedModel)) &&
        // Adobe 编辑适配器不会把 mask 发给上游；局部编辑不能降级为整图编辑。
        !requiresMask &&
        (effectiveRequestKind === "image_generation" ||
          effectiveRequestKind === "image_edit") &&
        canAdobeBackendServeModel({
          enabledModels: row.enabledModels,
          supportsVideo: row.supportsVideo,
          requestedModel,
        }) &&
        // 视频管线目前只实现 Adobe direct。网关成员即使误开 supportsVideo 也不能被选中，
        // 否则会先占用租约、扣费流程才报“非直连后端”。
        (!isFireflyVideoModelId(requestedModel) || row.mode === "direct") &&
        groupBackendAllowsRequest(metadata, effectiveRequestKind)
      );
    })
    .map((row) => {
      const matchedGroupId = row.matchedGroupId || row.groupId;
      const context = matchedGroupId ? contextMap.get(matchedGroupId) : null;
      return {
        type: "adobe" as const,
        id: row.id,
        alwaysActive: row.alwaysActive,
        groupId: matchedGroupId,
        groupIds: normalizeMemberGroupIds([row.groupId, row.matchedGroupId]),
        groupMetadata: context?.metadata ?? groupMetadata ?? null,
        groupContentSafetyEnabled:
          context?.contentSafetyEnabled ?? groupContentSafetyEnabled ?? null,
        name: row.name,
        mode: row.mode,
        baseUrl: row.baseUrl,
        apiKey: row.apiKey,
        enabledModels: row.enabledModels ?? null,
        defaultRatio: row.defaultRatio,
        defaultResolution: row.defaultResolution,
        gptImageQuality: row.gptImageQuality,
        supportsVideo: row.supportsVideo,
        contentSafetyEnabled: row.contentSafetyEnabled,
        priority: row.priority,
        concurrency: row.concurrency,
        lastUsedAt: row.lastUsedAt,
        lastAcquiredAt: row.lastAcquiredAt,
        createdAt: row.createdAt,
        metadata: row.metadata,
      };
    });

  const notExcludedCandidates = [...apiMembers, ...adobeMembers].filter(
    (member) => !excluded?.has(backendKey(member))
  );
  const availableCandidates = notExcludedCandidates.filter(hasBackendCapacity);
  const stickyPreviousCandidates = stickyPreviousMember
    ? availableCandidates
        .filter(
          (member) =>
            member.type === stickyPreviousMember.type &&
            member.id === stickyPreviousMember.id
        )
        .map((member) => ({
          ...member,
          schedulerLayer: "previous_response_id" as const,
        }))
    : [];
  const stickySessionCandidates = stickySessionMember
    ? availableCandidates
        .filter(
          (member) =>
            member.type === stickySessionMember.type &&
            member.id === stickySessionMember.id &&
            !stickyPreviousCandidates.some(
              (stickyMember) => backendKey(stickyMember) === backendKey(member)
            )
        )
        .map((member) => ({
          ...member,
          schedulerLayer: "session_hash" as const,
        }))
    : [];
  const preferredCandidates =
    preferredMemberId || preferredMemberType
      ? availableCandidates.filter(
          (member) =>
            (!preferredMemberId || member.id === preferredMemberId) &&
            (!preferredMemberType || member.type === preferredMemberType) &&
            !stickyPreviousCandidates.some(
              (stickyMember) => backendKey(stickyMember) === backendKey(member)
            ) &&
            !stickySessionCandidates.some(
              (stickyMember) => backendKey(stickyMember) === backendKey(member)
            )
        )
      : [];
  const markedPreferredCandidates = preferredCandidates.map((member) => ({
    ...member,
    schedulerLayer: "preferred" as const,
  }));
  const ordinaryCandidatePool = availableCandidates.filter(
    (member) =>
      !stickyPreviousCandidates.some(
        (stickyMember) => backendKey(stickyMember) === backendKey(member)
      ) &&
      !stickySessionCandidates.some(
        (stickyMember) => backendKey(stickyMember) === backendKey(member)
      ) &&
      !preferredCandidates.includes(member)
  );
  const ordinaryCandidateGroups = new Map<string, PoolMember[]>();
  const ordinaryGroupOrder: string[] = [];
  for (const member of ordinaryCandidatePool) {
    const key = [member.priority, healthBucket(member)].join(":");
    if (!ordinaryCandidateGroups.has(key)) {
      ordinaryCandidateGroups.set(key, []);
      ordinaryGroupOrder.push(key);
    }
    ordinaryCandidateGroups.get(key)?.push(member);
  }
  ordinaryGroupOrder.sort((leftKey, rightKey) => {
    const left = ordinaryCandidateGroups.get(leftKey)?.[0];
    const right = ordinaryCandidateGroups.get(rightKey)?.[0];
    if (!left || !right) return 0;
    const priorityDiff = left.priority - right.priority;
    if (priorityDiff !== 0) return priorityDiff;
    return healthBucket(left) - healthBucket(right);
  });
  const ordinaryCandidates = ordinaryGroupOrder
    .flatMap((groupKey) => {
      const group = ordinaryCandidateGroups.get(groupKey) || [];
      const sortedGroup = group.sort((left, right) => {
        const acquiredDiff =
          memberTimestamp(left.lastAcquiredAt) -
          memberTimestamp(right.lastAcquiredAt);
        if (acquiredDiff !== 0) return acquiredDiff;
        const lastUsedDiff =
          memberTimestamp(left.lastUsedAt) - memberTimestamp(right.lastUsedAt);
        if (lastUsedDiff !== 0) return lastUsedDiff;
        return (
          memberTimestamp(left.createdAt) - memberTimestamp(right.createdAt)
        );
      });
      return sortedGroup;
    })
    .map((member) => ({
      ...member,
      schedulerLayer: "load_balance" as const,
    }));
  const candidates = [
    ...stickyPreviousCandidates,
    ...stickySessionCandidates,
    ...markedPreferredCandidates,
    ...ordinaryCandidates,
  ];

  let sawStaleCandidate = false;
  for (const member of candidates) {
    const leaseResult = await acquirePoolMemberInflightLease(member, {
      enforceLastAcquiredSnapshot:
        (member.schedulerLayer || "load_balance") === "load_balance",
    });
    if (leaseResult === "stale") {
      sawStaleCandidate = true;
      continue;
    }
    if (leaseResult === "acquired") {
      await recordSchedulerMetric({
        requestKind,
        layer: member.schedulerLayer || "load_balance",
        memberType: member.type,
        memberId: member.id,
        groupId: member.groupId,
        candidateCount: availableCandidates.length,
        latencyMs: Date.now() - selectionStartedAt,
      });
      return member;
    }
  }

  if (
    sawStaleCandidate &&
    staleRetryCount < MAX_BACKEND_STALE_SELECTION_RETRIES
  ) {
    return selectPoolMember(
      groupId,
      groupMetadata,
      groupContentSafetyEnabled,
      groupContexts,
      requestKind,
      excluded,
      preferredMemberId,
      preferredMemberType,
      stickyPreviousMember,
      stickySessionMember,
      requestedModel,
      forceFirefly,
      requiresMask,
      staleRetryCount + 1
    );
  }

  return null;
}

async function touchSelectedMember(member: PoolMember) {
  const now = new Date();
  if (member.type === "api") {
    await db
      .update(imageBackendApi)
      .set({
        status: "active",
        cooldownUntil: null,
        lastUsedAt: now,
        lastAcquiredAt: now,
        updatedAt: now,
      })
      .where(eq(imageBackendApi.id, member.id));
    return;
  }

  if (member.type === "adobe") {
    await db
      .update(imageBackendAdobe)
      .set({
        status: "active",
        cooldownUntil: null,
        lastUsedAt: now,
        lastAcquiredAt: now,
        updatedAt: now,
      })
      .where(eq(imageBackendAdobe.id, member.id));
  }
}

function toResolvedPoolConfig(
  fallbackGroupId: string,
  member: PoolMember,
  options: ResolveBackendOptions,
  billingGroupMetadata?: Record<string, unknown> | null
): ResolvedImageBackendPoolConfig {
  const groupId = member.groupId || fallbackGroupId;
  const contentSafetyEnabled = effectiveContentSafety(
    member.groupContentSafetyEnabled,
    member.contentSafetyEnabled
  );
  // 目标分组 backendType 会进入解析配置，供下游按分组接口语义处理请求。
  const groupBackendType = getGroupBackendType(billingGroupMetadata);
  const imageCreditOverrides =
    getGroupImageCreditOverrides(billingGroupMetadata);
  const videoCreditOverrides =
    getGroupVideoCreditOverrides(billingGroupMetadata);

  if (member.type === "api") {
    return {
      config: {
        baseUrl: stripTrailingSlash(member.baseUrl),
        apiKey: member.apiKey,
        model: member.model || undefined,
        useStream: member.useStream,
        contentSafetyEnabled,
        backend: {
          type: "pool-api",
          id: member.id,
          groupId,
          groupBackendType,
          userId: options.userId,
          apiKeyId: options.apiKeyId,
          requestedBackendGroupId: options.backendGroupId,
          requestKind: options.requestKind,
          requiresMask: options.requiresMask,
          apiInterfaceMode: member.interfaceMode,
          chatCompletionsUpstreamMode: member.chatCompletionsUpstreamMode,
          imagesUpstreamMode: member.imagesUpstreamMode,
          parameterMappings: member.parameterMappings,
          adobeSourced: member.adobeSourced,
          billingGroupId: fallbackGroupId,
          imageCreditOverrides,
          videoCreditOverrides,
          reportResult: true,
          inflightLease: true,
          inflightLeaseId: member.leaseId,
          inflightLeasePersisted: member.leasePersisted,
        },
      },
      groupId,
      memberId: member.id,
      memberType: "api",
      contentSafetyEnabled,
      schedulerLayer: member.schedulerLayer,
    };
  }

  return {
    config: {
      baseUrl: stripTrailingSlash(member.baseUrl),
      apiKey: member.apiKey,
      contentSafetyEnabled,
      backend: {
        type: "pool-adobe",
        id: member.id,
        groupId,
        groupBackendType,
        userId: options.userId,
        apiKeyId: options.apiKeyId,
        requestedBackendGroupId: options.backendGroupId,
        requestKind: options.requestKind,
        requiresMask: options.requiresMask,
        adobeMode: member.mode === "direct" ? "direct" : "gateway",
        adobeEnabledModels: member.enabledModels,
        adobeDefaultRatio: member.defaultRatio,
        adobeDefaultResolution: member.defaultResolution,
        adobeGptImageQuality: member.gptImageQuality,
        adobeSupportsVideo: member.supportsVideo,
        billingGroupId: fallbackGroupId,
        imageCreditOverrides,
        videoCreditOverrides,
        reportResult: true,
        inflightLease: true,
        inflightLeaseId: member.leaseId,
        inflightLeasePersisted: member.leasePersisted,
      },
    },
    groupId,
    memberId: member.id,
    memberType: "adobe",
    contentSafetyEnabled,
    schedulerLayer: member.schedulerLayer,
  };
}

async function resolvePoolMember(
  options: ResolveBackendOptions & { excluded?: Set<string> }
) {
  const userPlan = await getUserPlan(options.userId);
  const requestedGroup = await resolveRequestedGroup(options, userPlan.plan);
  const requestedGroupId = requestedGroup.groupId;
  const group = await ensureGroupUsable(requestedGroupId, userPlan.plan);
  if (!group) {
    if (requestedGroup.explicit) {
      throw new ImageBackendPoolUnavailableError(
        "选择的生图后端分组不可用或当前套餐不可用"
      );
    }
    return null;
  }

  if (!groupBackendAllowsRequest(group.metadata, options.requestKind)) {
    if (requestedGroup.explicit) {
      throw new ImageBackendPoolUnavailableError(
        `生图后端分组「${group.name}」不支持当前请求类型`
      );
    }
    return null;
  }

  const [stickyPreviousMember, stickySessionMember] = await Promise.all([
    resolveStickyBinding({
      layer: "previous_response_id",
      key: options.stickyPreviousResponseId,
    }),
    resolveStickyBinding({
      layer: "session_hash",
      key: options.stickySessionKey,
    }),
  ]);

  const member = await selectPoolMember(
    group.id,
    group.metadata,
    group.contentSafetyEnabled,
    await listSelectableGroupContexts(
      group,
      userPlan.plan,
      options.requestKind
    ),
    options.requestKind,
    options.excluded,
    options.preferredMemberId,
    options.preferredMemberType,
    stickyPreviousMember,
    stickySessionMember,
    options.requestedModel,
    options.forceFirefly,
    options.requiresMask,
    0
  );
  if (!member) {
    if (requestedGroup.explicit) {
      throw new ImageBackendPoolUnavailableError(
        `生图后端分组「${group.name}」没有可用媒体后端`
      );
    }
    return null;
  }

  return { group, member };
}

export async function resolveImageBackendPoolConfig(
  options: ResolveBackendOptions & { excludedMemberKeys?: string[] }
): Promise<ResolvedImageBackendPoolConfig | null> {
  const resolved = await resolvePoolMember({
    ...options,
    excluded: new Set(options.excludedMemberKeys || []),
  });
  if (!resolved) return null;
  try {
    if (!resolved.member.leaseTouchedMember) {
      await touchSelectedMember(resolved.member);
    }
    const result = toResolvedPoolConfig(
      resolved.group.id,
      resolved.member,
      options,
      resolved.group.metadata
    );
    // 盖 Adobe 意图(与 selectPoolMember 的 fireflyOnly 同口径):让换号重试能保持「只走
    // Adobe」，避免 Firefly 图像或 Veo/Kling 视频请求被重试到非 Adobe 后端。
    if (result?.config.backend) {
      result.config.backend.fireflyOnly =
        options.forceFirefly === true ||
        isAdobeFireflyModelId(options.requestedModel) ||
        isFireflyVideoModelId(options.requestedModel);
    }
    return result;
  } catch (error) {
    await releaseImageBackendInflightLease({
      memberType: resolved.member.type,
      memberId: resolved.member.id,
      leaseId: resolved.member.leaseId,
      leasePersisted: resolved.member.leasePersisted,
    });
    throw error;
  }
}

export async function reportImageBackendResult(
  input: ImageBackendReportResultInput
): Promise<ImageBackendReportResultOutcome> {
  if (!input.memberId || !input.memberType) {
    return { success: input.success, retryable: false, switchable: false };
  }
  const now = new Date();
  const error = truncateError(input.error);
  const failure = input.success ? {} : await classifyFailure(error, input);

  if (input.memberType === "api") {
    const [api] = await db
      .select({
        metadata: imageBackendApi.metadata,
        alwaysActive: imageBackendApi.alwaysActive,
        status: imageBackendApi.status,
        failureCooldownEnabled: imageBackendApi.failureCooldownEnabled,
      })
      .from(imageBackendApi)
      .where(eq(imageBackendApi.id, input.memberId))
      .limit(1);
    const alwaysActive = api?.alwaysActive ?? false;
    const effectiveFailure = input.success
      ? failure
      : resolveEffectiveFailureForMember(
          failure,
          api?.failureCooldownEnabled ?? false
        );
    const outcome = {
      success: input.success,
      status: effectiveFailure.status,
      cooldownUntil: effectiveFailure.cooldownUntil,
      retryable:
        !input.success &&
        isClassifiedFailureRecoverable(error, effectiveFailure),
      switchable: !input.success && isImageBackendSwitchableError(error),
    };
    const metadata = nextSchedulerMetadataAfterResult(
      api?.metadata,
      input,
      now
    );
    // always_active：常驻后端遇任何失败（含 502/HTML 等 dead-relay 终态错误）都不自动下线，
    // 仅记 lastError/failCount，详见 resolveAlwaysActiveFailure。
    const apiFailure = resolveAlwaysActiveFailure(
      alwaysActive,
      effectiveFailure
    );
    // error 粘性：非常驻后端一旦被置 error，成功不再复活它（高并发下成功多来自
    // 早已在飞的兄弟请求）。只由 测活/手动重新启用/编辑保存/常驻 清除 error。
    const stickyError = api?.status === "error" && !alwaysActive;
    await db
      .update(imageBackendApi)
      .set(
        input.success
          ? stickyError
            ? {
                successCount: sql`${imageBackendApi.successCount} + 1`,
                metadata,
                updatedAt: now,
              }
            : {
                successCount: sql`${imageBackendApi.successCount} + 1`,
                metadata,
                status: "active",
                lastError: null,
                lastErrorAt: null,
                cooldownUntil: null,
                updatedAt: now,
              }
          : {
              failCount: sql`${imageBackendApi.failCount} + 1`,
              metadata,
              ...(apiFailure.status ? { status: apiFailure.status } : {}),
              ...(apiFailure.cooldownUntil !== undefined
                ? { cooldownUntil: apiFailure.cooldownUntil }
                : {}),
              lastError: error,
              lastErrorAt: now,
              updatedAt: now,
            }
      )
      .where(eq(imageBackendApi.id, input.memberId));
    if (!input.success) {
      logWarn("生图 API 后端失败，已更新调度状态", {
        memberType: input.memberType,
        memberId: input.memberId,
        status: effectiveFailure.status || "unchanged",
        cooldownUntil: effectiveFailure.cooldownUntil
          ? effectiveFailure.cooldownUntil.toISOString()
          : null,
        retryable: outcome.retryable,
        switchable: outcome.switchable,
        error,
      });
    }
    return outcome;
  }

  if (input.memberType === "adobe") {
    const [adobe] = await db
      .select({
        metadata: imageBackendAdobe.metadata,
        alwaysActive: imageBackendAdobe.alwaysActive,
        status: imageBackendAdobe.status,
        failureCooldownEnabled: imageBackendAdobe.failureCooldownEnabled,
      })
      .from(imageBackendAdobe)
      .where(eq(imageBackendAdobe.id, input.memberId))
      .limit(1);
    const alwaysActive = adobe?.alwaysActive ?? false;
    const effectiveFailure = input.success
      ? failure
      : resolveEffectiveFailureForMember(
          failure,
          adobe?.failureCooldownEnabled ?? false
        );
    const outcome = {
      success: input.success,
      status: effectiveFailure.status,
      cooldownUntil: effectiveFailure.cooldownUntil,
      retryable:
        !input.success &&
        isClassifiedFailureRecoverable(error, effectiveFailure),
      switchable: !input.success && isImageBackendSwitchableError(error),
    };
    const metadata = nextSchedulerMetadataAfterResult(
      adobe?.metadata,
      input,
      now
    );
    // 与 api 同款：always_active 常驻后端遇任何失败都不自动下线（含终态 502/HTML），
    // 详见 resolveAlwaysActiveFailure。
    const adobeFailure = resolveAlwaysActiveFailure(
      alwaysActive,
      effectiveFailure
    );
    const stickyError = adobe?.status === "error" && !alwaysActive;
    await db
      .update(imageBackendAdobe)
      .set(
        input.success
          ? stickyError
            ? {
                successCount: sql`${imageBackendAdobe.successCount} + 1`,
                metadata,
                updatedAt: now,
              }
            : {
                successCount: sql`${imageBackendAdobe.successCount} + 1`,
                metadata,
                status: "active",
                lastError: null,
                lastErrorAt: null,
                cooldownUntil: null,
                updatedAt: now,
              }
          : {
              failCount: sql`${imageBackendAdobe.failCount} + 1`,
              metadata,
              ...(adobeFailure.status ? { status: adobeFailure.status } : {}),
              ...(adobeFailure.cooldownUntil !== undefined
                ? { cooldownUntil: adobeFailure.cooldownUntil }
                : {}),
              lastError: error,
              lastErrorAt: now,
              updatedAt: now,
            }
      )
      .where(eq(imageBackendAdobe.id, input.memberId));
    if (!input.success) {
      logWarn("生图 Adobe 后端失败，已更新调度状态", {
        memberType: input.memberType,
        memberId: input.memberId,
        status: effectiveFailure.status || "unchanged",
        cooldownUntil: effectiveFailure.cooldownUntil
          ? effectiveFailure.cooldownUntil.toISOString()
          : null,
        retryable: outcome.retryable,
        switchable: outcome.switchable,
        error,
      });
    }
    return outcome;
  }

  throw new Error("不支持的媒体后端类型");
}

export async function listImageBackendGroupOptions(options?: {
  userSelectableOnly?: boolean;
  plan?: SubscriptionPlan;
}) {
  const plan = options?.plan;
  const rows = await db
    .select({
      id: imageBackendGroup.id,
      name: imageBackendGroup.name,
      description: imageBackendGroup.description,
      isDefault: imageBackendGroup.isDefault,
      isUserSelectable: imageBackendGroup.isUserSelectable,
      isEnabled: imageBackendGroup.isEnabled,
      contentSafetyEnabled: imageBackendGroup.contentSafetyEnabled,
      priority: imageBackendGroup.priority,
      metadata: imageBackendGroup.metadata,
    })
    .from(imageBackendGroup)
    .where(
      options?.userSelectableOnly
        ? and(
            eq(imageBackendGroup.isEnabled, true),
            eq(imageBackendGroup.isUserSelectable, true)
          )
        : eq(imageBackendGroup.isEnabled, true)
    )
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt));
  return rows
    .filter((group) =>
      plan ? canUseBackendGroupForPlan(group.metadata, plan) : true
    )
    .map(({ metadata, ...group }) => ({
      ...group,
      minPlan: getGroupMinPlan(metadata),
      backendType: getGroupBackendType(metadata),
      imageCreditOverrides: getGroupImageCreditOverrides(metadata),
      videoCreditOverrides: getGroupVideoCreditOverrides(metadata),
      childGroupIds: getGroupChildGroupIds(metadata),
    }));
}

/**
 * 取得平台默认生图分组的计费上下文。
 *
 * @param plan - 当前套餐，用于过滤无权使用的分组。
 * @returns 平台默认分组；无可用分组时返回 null。
 *
 * WHY: 创作页和账单的预估必须与调度器在无显式请求分组时的默认路由一致，
 * 否则会漏掉默认分组的模型固定价格和审核开关。
 */
export async function getEffectiveDefaultImageBackendGroup(
  plan: SubscriptionPlan
) {
  const groupId = await getDefaultGroupId();
  const group = await ensureGroupUsable(groupId, plan);
  if (!group) return null;

  return {
    id: group.id,
    name: group.name,
    isDefault: group.isDefault,
    backendType: getGroupBackendType(group.metadata),
    contentSafetyEnabled: group.contentSafetyEnabled,
    imageCreditOverrides: getGroupImageCreditOverrides(group.metadata),
    videoCreditOverrides: getGroupVideoCreditOverrides(group.metadata),
  };
}

/**
 * 获取创作页可安全展示的分组与模型目录。
 *
 * @param plan - 当前套餐，用于过滤无权使用的分组和手动选择能力。
 * @returns 不含凭据的分组模型目录；不可手选的有效默认组以隐式路由方式保留。
 * @remarks 目录只提供展示和前端预检，提交时仍必须在调度器重新授权。
 */
export async function getImageGenerationModelCatalogForPlan(
  plan: SubscriptionPlan
): Promise<ImageGenerationModelCatalog> {
  const [allGroups, effectiveGroup, canSelectGroups] = await Promise.all([
    listImageBackendGroupOptions({ plan }),
    getEffectiveDefaultImageBackendGroup(plan),
    canUsePlanCapability(plan, "backendGroups.select"),
  ]);
  const groupsById = new Map(allGroups.map((group) => [group.id, group]));
  const selectableGroupIds = new Set(
    canSelectGroups
      ? allGroups
          .filter((group) => group.isUserSelectable)
          .map((group) => group.id)
      : []
  );
  const catalogGroupIds = new Set<string>();
  if (effectiveGroup) catalogGroupIds.add(effectiveGroup.id);
  for (const groupId of selectableGroupIds) catalogGroupIds.add(groupId);

  const groups = Array.from(catalogGroupIds)
    .map((groupId) => groupsById.get(groupId))
    .filter((group): group is NonNullable<ReturnType<typeof groupsById.get>> =>
      Boolean(group)
    )
    .map((group) => ({
      id: group.id,
      name: group.name,
      isDefault: group.isDefault,
      imageCreditOverrides: group.imageCreditOverrides,
      routingMode: selectableGroupIds.has(group.id)
        ? ("explicit-selectable" as const)
        : ("implicit-default" as const),
    }));
  if (!groups.length) return { groups: [] };

  const catalogMemberGroupMap = buildImageGenerationCatalogMemberGroupMap({
    catalogGroupIds: groups.map((group) => group.id),
    groups: allGroups.map((group) => ({
      id: group.id,
      backendType: group.backendType,
      childGroupIds: group.childGroupIds,
    })),
  });
  const memberLookupGroupIds = Array.from(catalogMemberGroupMap.keys());
  const enabledNonTerminalMember = <
    T extends {
      isEnabled: unknown;
      status: unknown;
    },
  >(
    table: T
  ) =>
    and(
      eq(table.isEnabled as never, true),
      sql`${table.status as never} <> 'error'`
    );
  const now = new Date();
  const [apiRows, adobeRows] = await Promise.all([
    db
      .select({
        matchedGroupId: imageBackendApiGroup.groupId,
        groupId: imageBackendApi.groupId,
        model: imageBackendApi.model,
        supportedModelIds: imageBackendApi.supportedModelIds,
        interfaceMode: imageBackendApi.interfaceMode,
        imageUpstreamMode: imageBackendApi.imageUpstreamMode,
        adobeSourced: imageBackendApi.adobeSourced,
        isEnabled: imageBackendApi.isEnabled,
        alwaysActive: imageBackendApi.alwaysActive,
        status: imageBackendApi.status,
        cooldownUntil: imageBackendApi.cooldownUntil,
      })
      .from(imageBackendApi)
      .leftJoin(
        imageBackendApiGroup,
        eq(imageBackendApiGroup.apiId, imageBackendApi.id)
      )
      .where(
        and(
          enabledNonTerminalMember(imageBackendApi),
          or(
            inArray(imageBackendApiGroup.groupId, memberLookupGroupIds),
            inArray(imageBackendApi.groupId, memberLookupGroupIds)
          )
        )
      ),
    db
      .select({
        matchedGroupId: imageBackendAdobeGroup.groupId,
        groupId: imageBackendAdobe.groupId,
        enabledModels: imageBackendAdobe.enabledModels,
        isEnabled: imageBackendAdobe.isEnabled,
        alwaysActive: imageBackendAdobe.alwaysActive,
        status: imageBackendAdobe.status,
        cooldownUntil: imageBackendAdobe.cooldownUntil,
      })
      .from(imageBackendAdobe)
      .leftJoin(
        imageBackendAdobeGroup,
        eq(imageBackendAdobeGroup.adobeId, imageBackendAdobe.id)
      )
      .where(
        and(
          enabledNonTerminalMember(imageBackendAdobe),
          or(
            inArray(imageBackendAdobeGroup.groupId, memberLookupGroupIds),
            inArray(imageBackendAdobe.groupId, memberLookupGroupIds)
          )
        )
      ),
  ]);
  const resolveCatalogGroupIds = (
    matchedGroupId: string | null,
    groupId: string | null
  ) => {
    const resolvedGroupIds = new Set<string>();
    for (const memberGroupId of [matchedGroupId, groupId]) {
      if (!memberGroupId) continue;
      for (const catalogGroupId of catalogMemberGroupMap.get(memberGroupId) ||
        []) {
        resolvedGroupIds.add(catalogGroupId);
      }
    }
    return Array.from(resolvedGroupIds);
  };
  const members: ImageGenerationCatalogMember[] = [];

  for (const row of apiRows) {
    if (!isImageGenerationCatalogMemberAvailable(row, now)) continue;
    const edit = imageBackendApiInterfaceAllowsRequest(
      row.interfaceMode,
      "image_edit",
      row.imageUpstreamMode
    );
    for (const groupId of resolveCatalogGroupIds(
      row.matchedGroupId,
      row.groupId
    )) {
      members.push({
        groupId,
        type: "api",
        adobeSourced: row.adobeSourced,
        defaultModel: row.model,
        supportedModelIds: row.supportedModelIds,
        capabilities: {
          generate: imageBackendApiInterfaceAllowsRequest(
            row.interfaceMode,
            "image_generation",
            row.imageUpstreamMode
          ),
          edit,
          mask: edit,
        },
      });
    }
  }
  for (const row of adobeRows) {
    if (!isImageGenerationCatalogMemberAvailable(row, now)) continue;
    for (const groupId of resolveCatalogGroupIds(
      row.matchedGroupId,
      row.groupId
    )) {
      members.push({
        groupId,
        type: "adobe",
        enabledModels: row.enabledModels,
        capabilities: { generate: true, edit: true, mask: false },
      });
    }
  }

  return buildImageGenerationModelCatalog({ groups, members });
}

type UpsertGroupInput = {
  id?: string;
  name: string;
  description?: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  isUserSelectable: boolean;
  contentSafetyEnabled: boolean | null;
  backendType: ImageBackendGroupBackendType;
  minPlan: SubscriptionPlan;
  imageCreditOverrides: ImageCreditOverrides;
  videoCreditOverrides: Record<string, number>;
  childGroupIds?: string[];
  priority: number;
};

async function normalizeUpsertGroupChildGroupIds(input: UpsertGroupInput) {
  const groups = await db
    .select({
      id: imageBackendGroup.id,
      name: imageBackendGroup.name,
      metadata: imageBackendGroup.metadata,
    })
    .from(imageBackendGroup)
    .orderBy(asc(imageBackendGroup.createdAt));
  const result = validateNestedGroupConfig({
    groupId: input.id,
    backendType: input.backendType,
    childGroupIds: input.childGroupIds,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      backendType: getGroupBackendType(group.metadata),
      childGroupIds: getGroupChildGroupIds(group.metadata),
    })),
  });
  if (!result.ok) throw new Error(result.error);

  return result.childGroupIds;
}

export async function upsertImageBackendGroup(input: UpsertGroupInput) {
  const childGroupIds = await normalizeUpsertGroupChildGroupIds(input);

  if (input.isDefault) {
    await db.update(imageBackendGroup).set({
      isDefault: false,
      updatedAt: new Date(),
    });
  }

  if (input.id) {
    const [existing] = await db
      .select({ metadata: imageBackendGroup.metadata })
      .from(imageBackendGroup)
      .where(eq(imageBackendGroup.id, input.id))
      .limit(1);
    const metadata = {
      ...withoutLegacyGroupBillingMetadata(existing?.metadata),
      minPlan: input.minPlan,
      backendType: input.backendType,
      imageCreditOverrides: input.imageCreditOverrides,
      videoCreditOverrides: input.videoCreditOverrides,
      childGroupIds,
    };
    await db
      .update(imageBackendGroup)
      .set({
        name: input.name,
        description: input.description || null,
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
        isUserSelectable: input.isUserSelectable,
        contentSafetyEnabled: input.contentSafetyEnabled,
        metadata,
        priority: input.priority,
        updatedAt: new Date(),
      })
      .where(eq(imageBackendGroup.id, input.id));
    return input.id;
  }

  const id = nanoid();
  await db.insert(imageBackendGroup).values({
    id,
    name: input.name,
    description: input.description || null,
    isEnabled: input.isEnabled,
    isDefault: input.isDefault,
    isUserSelectable: input.isUserSelectable,
    contentSafetyEnabled: input.contentSafetyEnabled,
    metadata: {
      minPlan: input.minPlan,
      backendType: input.backendType,
      imageCreditOverrides: input.imageCreditOverrides,
      videoCreditOverrides: input.videoCreditOverrides,
      childGroupIds,
    },
    priority: input.priority,
  });
  return id;
}

export async function deleteImageBackendGroup(groupId: string) {
  await db.delete(imageBackendGroup).where(eq(imageBackendGroup.id, groupId));
}

type UpsertApiInput = {
  id?: string;
  groupId?: string | null;
  groupIds?: string[] | null;
  mergeGroupIds?: boolean;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model?: string | null;
  supportedModelIds?: string[];
  interfaceMode?: ImageBackendApiInterfaceMode;
  chatCompletionsUpstreamMode?: ChatCompletionsUpstreamMode;
  imagesUpstreamMode?: ImagesUpstreamMode;
  parameterMappings?: RequestParameterMapping[];
  useStream: boolean;
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive: boolean;
  failureCooldownEnabled: boolean;
  priority: number;
  concurrency: number;
  // Adobe 来源标记：开启后参与 Firefly 候选。
  adobeSourced?: boolean;
  status?: string;
};

// 同步一个 API 直透后端在 image_backend_api_group 中的分组成员关系。
// 镜像 setImageBackendAccountGroups:replace 为真时先删后插全量替换,为假时仅追加;
// 主键 `${apiId}:${groupId}` + onConflictDoNothing 保证幂等、并发重复插入不报错。
async function setImageBackendApiGroups(input: {
  apiId: string;
  groupIds: string[];
  replace: boolean;
}) {
  const groupIds = normalizeMemberGroupIds(input.groupIds);
  if (input.replace) {
    await db
      .delete(imageBackendApiGroup)
      .where(eq(imageBackendApiGroup.apiId, input.apiId));
  }
  if (!groupIds.length) return;

  await db
    .insert(imageBackendApiGroup)
    .values(
      groupIds.map((groupId) => ({
        id: `${input.apiId}:${groupId}`,
        apiId: input.apiId,
        groupId,
      }))
    )
    .onConflictDoNothing();
}

export async function upsertImageBackendApi(input: UpsertApiInput) {
  // groupIds 为多分组真相,primaryGroupId 保留为主分组/向后兼容(取首个分组)。
  const groupIds = memberGroupIdsFromInput(input);
  const primaryGroupId = groupIds[0] || null;
  let existingPrimaryGroupId: string | null | undefined;

  if (input.id) {
    const [existingApi] = await db
      .select({ groupId: imageBackendApi.groupId })
      .from(imageBackendApi)
      .where(eq(imageBackendApi.id, input.id))
      .limit(1);
    existingPrimaryGroupId = existingApi?.groupId ?? null;
  }

  // undefined 表示旧调用方尚未发送该字段，更新时必须保留既有声明；空数组则是管理员
  // 明确清空列表并恢复兼容的不限模型语义。
  const supportedModelIds =
    input.supportedModelIds === undefined
      ? undefined
      : normalizeSupportedModelIds(input.supportedModelIds);
  const updateBase = {
    name: input.name,
    baseUrl: stripTrailingSlash(input.baseUrl),
    model: input.model || null,
    ...(supportedModelIds === undefined ? {} : { supportedModelIds }),
    interfaceMode: normalizeImageBackendApiInterfaceMode(input.interfaceMode),
    chatCompletionsUpstreamMode: normalizeChatCompletionsUpstreamMode(
      input.chatCompletionsUpstreamMode
    ),
    imageUpstreamMode: normalizeImagesUpstreamMode(input.imagesUpstreamMode),
    parameterMappings: normalizeRequestParameterMappings(
      input.parameterMappings
    ),
    useStream: input.useStream,
    contentSafetyEnabled: input.contentSafetyEnabled,
    isEnabled: input.isEnabled,
    alwaysActive: input.alwaysActive,
    failureCooldownEnabled: input.failureCooldownEnabled,
    priority: input.priority,
    concurrency: Math.max(1, Math.min(10000, input.concurrency)),
    adobeSourced: input.adobeSourced ?? false,
    status: input.status || "active",
    updatedAt: new Date(),
  };

  if (input.id) {
    // 合并模式保留既有主分组,否则以本次首个分组为主分组。
    const update = {
      ...updateBase,
      groupId: input.mergeGroupIds
        ? existingPrimaryGroupId || primaryGroupId
        : primaryGroupId,
    };
    await db
      .update(imageBackendApi)
      .set(input.apiKey ? { ...update, apiKey: input.apiKey } : update)
      .where(eq(imageBackendApi.id, input.id));
    await setImageBackendApiGroups({
      apiId: input.id,
      groupIds,
      replace: !input.mergeGroupIds,
    });
    return input.id;
  }

  if (!input.apiKey) {
    throw new Error("apiKey is required");
  }

  const id = nanoid();
  const update = {
    ...updateBase,
    groupId: primaryGroupId,
  };
  await db.insert(imageBackendApi).values({
    id,
    ...update,
    apiKey: input.apiKey,
  });
  await setImageBackendApiGroups({
    apiId: id,
    groupIds,
    replace: true,
  });
  return id;
}

/**
 * 列出可在管理端复用的 API 后端参数映射模板。
 *
 * @returns 按名称排序的模板快照；数据库 JSON 会在返回前重新校验。
 */
export async function listImageBackendParameterMappingTemplates() {
  const templates = await db
    .select({
      id: imageBackendParameterMappingTemplate.id,
      name: imageBackendParameterMappingTemplate.name,
      parameterMappings: imageBackendParameterMappingTemplate.parameterMappings,
      createdAt: imageBackendParameterMappingTemplate.createdAt,
      updatedAt: imageBackendParameterMappingTemplate.updatedAt,
    })
    .from(imageBackendParameterMappingTemplate)
    .orderBy(asc(imageBackendParameterMappingTemplate.name));
  return templates.map((template) => ({
    ...template,
    parameterMappings: normalizeRequestParameterMappings(
      template.parameterMappings
    ),
  }));
}

/**
 * 新建或更新参数映射模板。
 *
 * @param input - 已由传输层校验过的模板名称、映射与可选 id。
 * @returns 持久化模板的 id。
 * @throws 模板不存在或名称冲突时由数据库错误向上传递。
 */
export async function upsertImageBackendParameterMappingTemplate(input: {
  id?: string;
  name: string;
  parameterMappings: RequestParameterMapping[];
}) {
  const now = new Date();
  const values = {
    name: input.name.trim(),
    parameterMappings: normalizeRequestParameterMappings(
      input.parameterMappings
    ),
    updatedAt: now,
  };
  if (input.id) {
    const result = await db
      .update(imageBackendParameterMappingTemplate)
      .set(values)
      .where(eq(imageBackendParameterMappingTemplate.id, input.id))
      .returning({ id: imageBackendParameterMappingTemplate.id });
    if (!result[0]) throw new Error("参数映射模板不存在");
    return result[0].id;
  }

  const id = nanoid();
  await db.insert(imageBackendParameterMappingTemplate).values({
    id,
    ...values,
  });
  return id;
}

/**
 * 删除一个参数映射模板。
 *
 * 模板并非 API 后端的外键，删除不会影响已保存的后端快照。
 *
 * @param id - 要删除的模板 id。
 */
export async function deleteImageBackendParameterMappingTemplate(id: string) {
  await db
    .delete(imageBackendParameterMappingTemplate)
    .where(eq(imageBackendParameterMappingTemplate.id, id));
}

// Adobe 后端与分组关系写入（镜像 setImageBackendApiGroups）。
async function setImageBackendAdobeGroups(input: {
  adobeId: string;
  groupIds: string[];
  replace: boolean;
}) {
  const groupIds = normalizeMemberGroupIds(input.groupIds);
  if (input.replace) {
    await db
      .delete(imageBackendAdobeGroup)
      .where(eq(imageBackendAdobeGroup.adobeId, input.adobeId));
  }
  if (!groupIds.length) return;
  await db
    .insert(imageBackendAdobeGroup)
    .values(
      groupIds.map((groupId) => ({
        id: `${input.adobeId}:${groupId}`,
        adobeId: input.adobeId,
        groupId,
      }))
    )
    .onConflictDoNothing();
}

export type UpsertAdobeInput = {
  id?: string;
  groupId?: string | null;
  groupIds?: string[];
  mergeGroupIds?: boolean;
  name: string;
  mode?: "gateway" | "direct";
  baseUrl: string;
  apiKey?: string;
  enabledModels?: string[] | null;
  defaultRatio: string;
  defaultResolution: string;
  gptImageQuality: string;
  supportsVideo: boolean;
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive: boolean;
  failureCooldownEnabled: boolean;
  priority: number;
  concurrency: number;
  status?: string;
};

/**
 * 新建/更新一个 Adobe（adobe2api）后端。镜像 upsertImageBackendApi：groupIds 为多分组
 * 真相，primaryGroupId（首个）保留为主分组；编辑时仅在传入 apiKey 时才覆写密钥。
 */
export async function upsertImageBackendAdobe(input: UpsertAdobeInput) {
  const groupIds = memberGroupIdsFromInput(input);
  const primaryGroupId = groupIds[0] || null;
  let existingPrimaryGroupId: string | null | undefined;

  if (input.id) {
    const [existing] = await db
      .select({ groupId: imageBackendAdobe.groupId })
      .from(imageBackendAdobe)
      .where(eq(imageBackendAdobe.id, input.id))
      .limit(1);
    existingPrimaryGroupId = existing?.groupId ?? null;
  }

  const mode = input.mode === "direct" ? "direct" : "gateway";
  const updateBase = {
    name: input.name,
    mode,
    baseUrl: stripTrailingSlash(input.baseUrl),
    enabledModels:
      input.enabledModels === undefined || input.enabledModels === null
        ? null
        : normalizeAdobeEnabledModelIds(input.enabledModels),
    defaultRatio: input.defaultRatio,
    defaultResolution: input.defaultResolution,
    gptImageQuality: input.gptImageQuality,
    supportsVideo: input.supportsVideo,
    contentSafetyEnabled: input.contentSafetyEnabled,
    isEnabled: input.isEnabled,
    alwaysActive: input.alwaysActive,
    failureCooldownEnabled: input.failureCooldownEnabled,
    priority: input.priority,
    concurrency: Math.max(1, Math.min(10000, input.concurrency)),
    status: input.status || "active",
    updatedAt: new Date(),
  };

  if (input.id) {
    const update = {
      ...updateBase,
      groupId: input.mergeGroupIds
        ? existingPrimaryGroupId || primaryGroupId
        : primaryGroupId,
    };
    await db
      .update(imageBackendAdobe)
      .set(input.apiKey ? { ...update, apiKey: input.apiKey } : update)
      .where(eq(imageBackendAdobe.id, input.id));
    await setImageBackendAdobeGroups({
      adobeId: input.id,
      groupIds,
      replace: !input.mergeGroupIds,
    });
    return input.id;
  }

  // direct 模式凭据为 Adobe 账号/cookie（另表），不需要网关 apiKey；gateway 模式必填。
  if (mode === "gateway" && !input.apiKey) {
    throw new Error("apiKey is required");
  }
  const id = nanoid();
  await db.insert(imageBackendAdobe).values({
    id,
    ...updateBase,
    groupId: primaryGroupId,
    apiKey: input.apiKey ?? "",
  });
  await setImageBackendAdobeGroups({ adobeId: id, groupIds, replace: true });
  return id;
}

/** 启用/停用一个 Adobe 后端（镜像 setImageBackendApiEnabled）。 */
export async function setImageBackendAdobeEnabled(input: {
  id: string;
  isEnabled: boolean;
}): Promise<void> {
  await db
    .update(imageBackendAdobe)
    .set({
      isEnabled: input.isEnabled,
      ...(input.isEnabled
        ? {
            status: "active",
            cooldownUntil: null,
            lastError: null,
            lastErrorAt: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendAdobe.id, input.id));
}

/** 设置一个 Adobe 后端的 always_active 开关（镜像 api 版）。 */
export async function setImageBackendAdobeAlwaysActive(input: {
  id: string;
  alwaysActive: boolean;
}): Promise<void> {
  await db
    .update(imageBackendAdobe)
    .set({
      alwaysActive: input.alwaysActive,
      ...(input.alwaysActive
        ? {
            status: "active",
            cooldownUntil: null,
            lastError: null,
            lastErrorAt: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendAdobe.id, input.id));
}

/**
 * 启用/停用一个 API 直透后端（"是否启用"快速开关）。
 *
 * @param input.id 目标 imageBackendApi 行 id。
 * @param input.isEnabled 目标启用态。
 * @returns void。仅更新 isEnabled 与 updatedAt；停用后调度器不再选中该成员。
 */
export async function setImageBackendApiEnabled(input: {
  id: string;
  isEnabled: boolean;
}): Promise<void> {
  await db
    .update(imageBackendApi)
    .set({
      isEnabled: input.isEnabled,
      // 重新启用＝给次机会：清掉 error/冷却，让粘性 error 的后端回到候选。
      ...(input.isEnabled
        ? {
            status: "active",
            cooldownUntil: null,
            lastError: null,
            lastErrorAt: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendApi.id, input.id));
}

/**
 * 设置一个 API 直透后端的"遇错仍可用（always_active）"开关。
 *
 * 开启后（且 isEnabled 为真）：该 API 无视 status/cooldown 始终入选、失败不进
 * 冷却、不被置 error。关闭后恢复常规：失败可被调度器冷却/标 error 排除。
 * 开启时顺手把当前 error/cooldown 清掉，让它立即回到候选。
 *
 * @param input.id 目标 imageBackendApi 行 id。
 * @param input.alwaysActive 目标开关态。
 */
export async function setImageBackendApiAlwaysActive(input: {
  id: string;
  alwaysActive: boolean;
}): Promise<void> {
  await db
    .update(imageBackendApi)
    .set({
      alwaysActive: input.alwaysActive,
      ...(input.alwaysActive ? { status: "active", cooldownUntil: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(imageBackendApi.id, input.id));
}

/** 将测活失败结果格式化为中文，写入 lastError 供后台展示。 */
function describeImageHealthFailure(result: ImageApiHealthResult): string {
  switch (result.status) {
    case "no_image":
      return `测活：连接成功但未返回图片（${result.message}）`;
    case "auth_failed":
      return `测活：密钥被拒绝（${result.message}）`;
    case "unreachable":
      return `测活：无法连接或超时（${result.message}）`;
    default:
      return `测活：出图失败（${result.message}）`;
  }
}

/**
 * 测活：对一个 API 直透后端发起一次真实最小生图请求，看是否真的返回图片，
 * 并把结果落到该成员的健康字段。
 *
 * 成功（真返回图片）：清空 lastError/cooldownUntil 并置 status="active"。
 * 失败：写入 lastError/lastErrorAt 供后台展示。其中"出不了图（no_image）/密钥
 * 失效（auth_failed）"属确定性不可用 → 置 status="error" 踢出轮换；瞬时不可达/
 * 超时（unreachable）不擅自下线，仅记录，由管理员决定停用。
 * 复用 generateImage（reportResult=false），不改动 success/fail 计数；但会真实
 * 消耗上游 1 张图额度。
 *
 * @param id 目标 imageBackendApi 行 id。
 * @returns `{ id, name, result }`；成员不存在时抛错。
 */
export async function probeImageBackendApi(id: string): Promise<{
  id: string;
  name: string;
  result: ImageApiHealthResult;
}> {
  const [api] = await db
    .select({
      id: imageBackendApi.id,
      name: imageBackendApi.name,
      baseUrl: imageBackendApi.baseUrl,
      apiKey: imageBackendApi.apiKey,
      model: imageBackendApi.model,
      useStream: imageBackendApi.useStream,
      interfaceMode: imageBackendApi.interfaceMode,
      imageUpstreamMode: imageBackendApi.imageUpstreamMode,
      parameterMappings: imageBackendApi.parameterMappings,
      chatCompletionsUpstreamMode: imageBackendApi.chatCompletionsUpstreamMode,
      alwaysActive: imageBackendApi.alwaysActive,
    })
    .from(imageBackendApi)
    .where(eq(imageBackendApi.id, id))
    .limit(1);

  if (!api) {
    throw new Error("API 后端不存在");
  }

  const result = await checkImageBackendApiHealth({
    baseUrl: api.baseUrl,
    apiKey: api.apiKey,
    model: api.model,
    useStream: api.useStream,
    apiInterfaceMode: normalizeImageBackendApiInterfaceMode(api.interfaceMode),
    imagesUpstreamMode: normalizeImagesUpstreamMode(api.imageUpstreamMode),
    parameterMappings: normalizeRequestParameterMappings(api.parameterMappings),
    chatCompletionsUpstreamMode: normalizeChatCompletionsUpstreamMode(
      api.chatCompletionsUpstreamMode
    ),
    backendType: "pool-api",
  });

  const now = new Date();
  if (result.ok) {
    await db
      .update(imageBackendApi)
      .set({
        status: "active",
        lastError: null,
        lastErrorAt: null,
        cooldownUntil: null,
        updatedAt: now,
      })
      .where(eq(imageBackendApi.id, id));
  } else {
    // always_active：遇错也不下线——只记录 lastError，不置 error。
    const markError =
      !api.alwaysActive &&
      (result.status === "no_image" || result.status === "auth_failed");
    await db
      .update(imageBackendApi)
      .set({
        lastError: truncateError(describeImageHealthFailure(result)),
        lastErrorAt: now,
        ...(markError ? { status: "error" } : {}),
        updatedAt: now,
      })
      .where(eq(imageBackendApi.id, id));
  }

  return { id: api.id, name: api.name, result };
}

export async function deleteImageBackendMembers(input: {
  apiIds?: string[];
  adobeIds?: string[];
}) {
  let deletedApiCount = 0;
  let deletedAdobeCount = 0;
  if (input.apiIds?.length) {
    const apiIds = Array.from(new Set(input.apiIds.filter(Boolean)));
    for (let index = 0; index < apiIds.length; index += 500) {
      const chunk = apiIds.slice(index, index + 500);
      if (!chunk.length) continue;
      await db
        .delete(imageBackendApi)
        .where(inArray(imageBackendApi.id, chunk));
      deletedApiCount += chunk.length;
    }
  }
  if (input.adobeIds?.length) {
    const adobeIds = Array.from(new Set(input.adobeIds.filter(Boolean)));
    for (let index = 0; index < adobeIds.length; index += 500) {
      const chunk = adobeIds.slice(index, index + 500);
      if (!chunk.length) continue;
      await db
        .delete(imageBackendAdobe)
        .where(inArray(imageBackendAdobe.id, chunk));
      deletedAdobeCount += chunk.length;
    }
  }
  return { deletedApiCount, deletedAdobeCount };
}

/**
 * 列出当前启用且非终态错误的 API 后端已声明模型。
 *
 * `/v1/models` 使用此函数公布管理员配置的供应商模型；配置为空的旧后端仅回退公布
 * 默认模型，不会声称自己可枚举地支持任意模型。
 *
 * @returns 去重后的可公开模型 ID；不包含 API Key 等供应商敏感配置。
 */
export async function listEnabledImageBackendApiModelIds(): Promise<string[]> {
  const apis = await db
    .select({
      model: imageBackendApi.model,
      supportedModelIds: imageBackendApi.supportedModelIds,
    })
    .from(imageBackendApi)
    .where(
      and(
        eq(imageBackendApi.isEnabled, true),
        sql`${imageBackendApi.status} <> 'error'`
      )
    )
    .orderBy(asc(imageBackendApi.priority), asc(imageBackendApi.createdAt));

  return collectAdvertisedModelIds(apis);
}

/**
 * 列出当前可用 Adobe 后端明确开放的图像模型，以及是否存在可用视频后端。
 *
 * `/v1/models` 使用此函数避免公布没有健康后端可承接的 Firefly 模型。图像模型由
 * enabledModels 白名单决定；视频沿用既有 supportsVideo 开关，保持历史图像白名单不影响
 * 视频后端的兼容语义。
 *
 * @returns 可公开的 Adobe 图像模型与视频能力，不包含任何后端凭据。
 */
export async function listEnabledImageBackendAdobeModels(): Promise<{
  imageModelIds: string[];
  supportsVideo: boolean;
}> {
  const adobes = await db
    .select({
      enabledModels: imageBackendAdobe.enabledModels,
      mode: imageBackendAdobe.mode,
      supportsVideo: imageBackendAdobe.supportsVideo,
    })
    .from(imageBackendAdobe)
    .where(
      and(
        eq(imageBackendAdobe.isEnabled, true),
        sql`${imageBackendAdobe.status} <> 'error'`
      )
    )
    .orderBy(asc(imageBackendAdobe.priority), asc(imageBackendAdobe.createdAt));

  return {
    imageModelIds: collectAdvertisedAdobeImageModelIds(adobes),
    supportsVideo: adobes.some(
      (adobe) => adobe.mode === "direct" && adobe.supportsVideo
    ),
  };
}

export async function listAdminImageBackendPool() {
  const groups = await db
    .select()
    .from(imageBackendGroup)
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt));
  const apiCounts = await db
    .select({ groupId: imageBackendApiGroup.groupId, value: count() })
    .from(imageBackendApiGroup)
    .groupBy(imageBackendApiGroup.groupId);
  const apiCountMap = new Map(
    apiCounts.map((item) => [item.groupId, Number(item.value)])
  );

  const summaries = groups.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    isEnabled: group.isEnabled,
    isDefault: group.isDefault,
    isUserSelectable: group.isUserSelectable,
    contentSafetyEnabled: group.contentSafetyEnabled,
    backendType: getGroupBackendType(group.metadata),
    minPlan: getGroupMinPlan(group.metadata),
    imageCreditOverrides: getGroupImageCreditOverrides(group.metadata),
    videoCreditOverrides: getGroupVideoCreditOverrides(group.metadata),
    childGroupIds: getGroupChildGroupIds(group.metadata),
    priority: group.priority,
    apiCount: apiCountMap.get(group.id) ?? 0,
  }));

  const apis = await db
    .select({
      id: imageBackendApi.id,
      groupId: imageBackendApi.groupId,
      name: imageBackendApi.name,
      baseUrl: imageBackendApi.baseUrl,
      model: imageBackendApi.model,
      supportedModelIds: imageBackendApi.supportedModelIds,
      interfaceMode: imageBackendApi.interfaceMode,
      chatCompletionsUpstreamMode: imageBackendApi.chatCompletionsUpstreamMode,
      imagesUpstreamMode: imageBackendApi.imageUpstreamMode,
      parameterMappings: imageBackendApi.parameterMappings,
      useStream: imageBackendApi.useStream,
      contentSafetyEnabled: imageBackendApi.contentSafetyEnabled,
      isEnabled: imageBackendApi.isEnabled,
      alwaysActive: imageBackendApi.alwaysActive,
      failureCooldownEnabled: imageBackendApi.failureCooldownEnabled,
      priority: imageBackendApi.priority,
      concurrency: imageBackendApi.concurrency,
      adobeSourced: imageBackendApi.adobeSourced,
      status: imageBackendApi.status,
      successCount: imageBackendApi.successCount,
      failCount: imageBackendApi.failCount,
      lastUsedAt: imageBackendApi.lastUsedAt,
      cooldownUntil: imageBackendApi.cooldownUntil,
      lastError: imageBackendApi.lastError,
      lastErrorAt: imageBackendApi.lastErrorAt,
      createdAt: imageBackendApi.createdAt,
    })
    .from(imageBackendApi)
    .orderBy(asc(imageBackendApi.priority), desc(imageBackendApi.createdAt));
  const apiGroupRows = apis.length
    ? await db
        .select({
          apiId: imageBackendApiGroup.apiId,
          groupId: imageBackendApiGroup.groupId,
        })
        .from(imageBackendApiGroup)
        .where(
          inArray(
            imageBackendApiGroup.apiId,
            apis.map((api) => api.id)
          )
        )
    : [];
  const apiGroupIdMap = new Map<string, string[]>();
  for (const row of apiGroupRows) {
    const current = apiGroupIdMap.get(row.apiId) || [];
    current.push(row.groupId);
    apiGroupIdMap.set(row.apiId, current);
  }

  const adobes = await db
    .select({
      id: imageBackendAdobe.id,
      groupId: imageBackendAdobe.groupId,
      name: imageBackendAdobe.name,
      mode: imageBackendAdobe.mode,
      baseUrl: imageBackendAdobe.baseUrl,
      enabledModels: imageBackendAdobe.enabledModels,
      defaultRatio: imageBackendAdobe.defaultRatio,
      defaultResolution: imageBackendAdobe.defaultResolution,
      gptImageQuality: imageBackendAdobe.gptImageQuality,
      supportsVideo: imageBackendAdobe.supportsVideo,
      contentSafetyEnabled: imageBackendAdobe.contentSafetyEnabled,
      isEnabled: imageBackendAdobe.isEnabled,
      alwaysActive: imageBackendAdobe.alwaysActive,
      failureCooldownEnabled: imageBackendAdobe.failureCooldownEnabled,
      priority: imageBackendAdobe.priority,
      concurrency: imageBackendAdobe.concurrency,
      status: imageBackendAdobe.status,
      successCount: imageBackendAdobe.successCount,
      failCount: imageBackendAdobe.failCount,
      lastUsedAt: imageBackendAdobe.lastUsedAt,
      cooldownUntil: imageBackendAdobe.cooldownUntil,
      lastError: imageBackendAdobe.lastError,
      lastErrorAt: imageBackendAdobe.lastErrorAt,
      createdAt: imageBackendAdobe.createdAt,
    })
    .from(imageBackendAdobe)
    .orderBy(
      asc(imageBackendAdobe.priority),
      desc(imageBackendAdobe.createdAt)
    );
  const adobeGroupRows = adobes.length
    ? await db
        .select({
          adobeId: imageBackendAdobeGroup.adobeId,
          groupId: imageBackendAdobeGroup.groupId,
        })
        .from(imageBackendAdobeGroup)
        .where(
          inArray(
            imageBackendAdobeGroup.adobeId,
            adobes.map((adobe) => adobe.id)
          )
        )
    : [];
  const adobeGroupIdMap = new Map<string, string[]>();
  for (const row of adobeGroupRows) {
    const current = adobeGroupIdMap.get(row.adobeId) || [];
    current.push(row.groupId);
    adobeGroupIdMap.set(row.adobeId, current);
  }

  return {
    groups: summaries,
    apis: apis.map((api) => ({
      ...api,
      supportedModelIds: normalizeSupportedModelIds(api.supportedModelIds),
      parameterMappings: normalizeRequestParameterMappings(
        api.parameterMappings
      ),
      groupIds:
        apiGroupIdMap.get(api.id) ||
        normalizeMemberGroupIds(api.groupId ? [api.groupId] : []),
    })),
    adobes: adobes.map((adobe) => ({
      ...adobe,
      groupIds:
        adobeGroupIdMap.get(adobe.id) ||
        normalizeMemberGroupIds(adobe.groupId ? [adobe.groupId] : []),
    })),
  };
}
