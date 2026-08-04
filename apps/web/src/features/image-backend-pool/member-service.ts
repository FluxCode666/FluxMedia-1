/**
 * 统一媒体后端成员服务。
 *
 * 职责：校验 `api | adobe` 成员契约和 HTTP(S) URL，在单一仓储事务中保存公共成员、
 * 恰好一个类型配置及全部分组关系，并提供脱敏管理快照、启用状态修改与安全删除。
 * 使用方：UOL pool operations 与管理后台；secret 永不出现在读取 DTO 中。
 */
import { normalizeCookieString } from "@repo/shared/adobe/firefly-direct";
import {
  type ApiModelMapping,
  type ApiUpstreamAdapterDraft,
  apiModelMappingsSchema,
  apiUpstreamAdapterDraftSchema,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  API_UPSTREAM_ADAPTER_OPERATION_IDS,
  type ApiUpstreamAdapterOperationId,
} from "@repo/shared/image-backend/api-upstream-script-contract";
import type { BackendMemberInput } from "@repo/shared/image-backend/member-contract";
import { backendMemberInputSchema } from "@repo/shared/image-backend/member-contract";
import { eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import { validateApiUpstreamScript } from "./api-upstream-script-runtime";
import { parseMediaUpstreamUrl } from "./media-upstream-url";

/** 成员服务可稳定映射到 UOL 的错误码。 */
export type BackendMemberServiceErrorCode =
  | "not_found"
  | "conflict"
  | "validation_error";

/** 成员服务错误；消息不包含上游 secret。 */
export class BackendMemberServiceError extends Error {
  /** 创建可安全映射的成员服务错误。 */
  constructor(
    readonly code: BackendMemberServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BackendMemberServiceError";
  }
}

/** Adobe direct Cookie 验证后可安全持久化的一对一凭据与余额快照。 */
export interface PreparedAdobeDirectCredential {
  accessToken: string;
  accountUserId: string | null;
  displayName: string | null;
  email: string | null;
  expiresAt: Date | null;
  creditsTotal: number | null;
  creditsUsed: number | null;
  creditsAvailable: number | null;
  creditsUpdatedAt: Date;
  creditsError: string | null;
}

/** 已补齐稳定 ID 和可选直连凭据的统一成员保存输入。 */
export type PersistedBackendMemberInput = BackendMemberInput & {
  id: string;
  isCreate: boolean;
  directCredential?: PreparedAdobeDirectCredential;
};

/** 脱敏 API 媒体配置。 */
export interface RedactedApiMemberConfig {
  baseUrl: string;
  hasApiKey: boolean;
  useStream: boolean;
  modelMappings: ApiModelMapping[];
  authentication?: ApiUpstreamAdapterDraft["authentication"];
  credentialScope?: string;
  operations?: ApiUpstreamAdapterDraft["operations"];
  currentAdapterVersion?: {
    id: string;
    revision: number;
    createdAt: string;
  };
}

/** 脱敏 Adobe gateway/direct 配置。 */
export type RedactedAdobeMemberConfig =
  | {
      mode: "gateway";
      baseUrl: string;
      hasApiKey: boolean;
      defaultRatio: string;
      defaultResolution: string;
      gptImageQuality: "low" | "medium" | "high";
    }
  | {
      mode: "direct";
      hasCookie: boolean;
      displayName: string | null;
      email: string | null;
      credentialStatus: "active" | "error" | "exhausted" | "invalid";
      lastRefreshAt: string | null;
      lastRefreshError: string | null;
      consecutiveFailures: number;
      fireflyCredentialStatus:
        | "active"
        | "error"
        | "exhausted"
        | "invalid"
        | null;
      fireflyLastRefreshAt: string | null;
      fireflyLastRefreshError: string | null;
      fireflyConsecutiveFailures: number;
      creditsTotal: number | null;
      creditsUsed: number | null;
      creditsAvailable: number | null;
      creditsUpdatedAt: string | null;
      creditsError: string | null;
      defaultRatio: string;
      defaultResolution: string;
      gptImageQuality: "low" | "medium" | "high";
    };

/** 管理后台统一成员列表项的公共字段。 */
interface BackendMemberAdminSummaryBase {
  id: string;
  name: string;
  groupIds: string[];
  supportedModelIds: string[];
  contentSafetyEnabled: boolean;
  isEnabled: boolean;
  alwaysActive: boolean;
  failureCooldownEnabled: boolean;
  priority: number;
  concurrency: number;
  status: string;
  healthStatus: string;
  inflightCount: number;
  leaseAcquiredCount: number;
  lastAcquiredAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** 管理后台统一成员列表项；类型与专属配置保持可判别关联。 */
export type BackendMemberAdminSummary = BackendMemberAdminSummaryBase &
  (
    | { type: "api"; config: RedactedApiMemberConfig }
    | { type: "adobe"; config: RedactedAdobeMemberConfig }
  );

/** 原子保存仓储返回的稳定结果。 */
export type SaveBackendMemberRepositoryResult =
  | {
      status: "saved";
      id: string;
      adapterVersion?: { id: string; revision: number } | null;
    }
  | { status: "not_found" }
  | { status: "already_exists" }
  | { status: "type_conflict" }
  | { status: "version_conflict" }
  | { status: "credential_scope_conflict" }
  | { status: "missing_secret" }
  | { status: "unknown_group" };

/** 安全删除仓储返回的稳定结果。 */
export type DeleteBackendMemberRepositoryResult =
  | "deleted"
  | "not_found"
  | "busy";

/** 手动重置成员运行状态的稳定仓储结果。 */
export type ResetBackendMemberStatusRepositoryResult = "reset" | "not_found";

/** 成员启用状态写入仓储返回的稳定结果。 */
export type SetBackendMemberEnabledRepositoryResult = "updated" | "not_found";

/** 成员服务依赖的事务仓储端口。 */
export interface BackendMemberRepository {
  saveMember(
    input: PersistedBackendMemberInput,
    now: Date
  ): Promise<SaveBackendMemberRepositoryResult>;
  listMembers(now: Date): Promise<BackendMemberAdminSummary[]>;
  resetMemberStatus(
    memberId: string,
    now: Date
  ): Promise<ResetBackendMemberStatusRepositoryResult>;
  setMemberEnabled(
    memberId: string,
    isEnabled: boolean,
    now: Date
  ): Promise<SetBackendMemberEnabledRepositoryResult>;
  deleteMember(
    memberId: string,
    now: Date
  ): Promise<DeleteBackendMemberRepositoryResult>;
}

/** 成员服务的可注入依赖。 */
export interface BackendMemberServiceDependencies {
  repository: BackendMemberRepository;
  createId?: () => string;
  now?: () => Date;
  validateUpstreamUrl?: (url: string) => Promise<unknown>;
  validateAdapterScript?: (
    script: string,
    operation: ApiUpstreamAdapterOperationId,
    stage: "request" | "response"
  ) => Promise<void>;
  prepareAdobeDirectCredential?: (
    cookie: string,
    scope?: string
  ) => Promise<PreparedAdobeDirectCredential>;
}

/** 统一成员服务公开接口。 */
export interface BackendMemberService {
  saveMember(input: unknown): Promise<{
    id: string;
    adapterVersion?: { id: string; revision: number } | null;
  }>;
  listMembers(): Promise<BackendMemberAdminSummary[]>;
  resetMemberStatus(memberId: string): Promise<{ success: true }>;
  setMemberEnabled(
    memberId: string,
    isEnabled: boolean
  ): Promise<{ id: string; isEnabled: boolean }>;
  deleteMember(memberId: string): Promise<{ success: true }>;
}

/** 防止一个成员重复声明相同分组，避免关系唯一约束变成不透明数据库错误。 */
function assertUniqueGroupIds(groupIds: readonly string[]): void {
  if (new Set(groupIds).size === groupIds.length) return;
  throw new BackendMemberServiceError(
    "validation_error",
    "媒体后端成员不能重复选择同一分组"
  );
}

/**
 * 归一化管理端粘贴的 Adobe Cookie。
 *
 * 导出扩展会生成 `{ cookie, headers }` JSON；成员表只持久化 IMS 刷新需要的
 * Cookie，避免把 Express 会话辅助字段误写入 Cookie 列，导致后续自动刷新失效。
 */
function normalizeAdobeDirectCookie(cookie: string): string {
  const normalized = normalizeCookieString(cookie);
  if (normalized) return normalized;
  throw new BackendMemberServiceError(
    "validation_error",
    "Adobe Cookie 导入内容不包含有效 Cookie"
  );
}

/** 基于 origin 与认证形态生成不可包含密钥的稳定凭据域。 */
function createApiCredentialScope(
  baseUrl: string,
  authentication: ApiUpstreamAdapterDraft["authentication"]
): string {
  const origin = new URL(baseUrl).origin.toLowerCase();
  return authentication.mode === "custom_header"
    ? `${origin}|${authentication.mode}:${authentication.headerName.toLowerCase()}`
    : `${origin}|${authentication.mode}`;
}

/** 从 API 成员保存输入构造不含密钥的不可变适配版本草稿。 */
function createApiAdapterDraft(
  input: Extract<BackendMemberInput, { type: "api" }>
): ApiUpstreamAdapterDraft {
  const operations = structuredClone(input.config.operations);
  return apiUpstreamAdapterDraftSchema.parse({
    baseUrl: input.config.baseUrl,
    useStream: input.config.useStream,
    modelMappings: input.config.modelMappings,
    authentication: input.config.authentication,
    credentialScope: createApiCredentialScope(
      input.config.baseUrl,
      input.config.authentication
    ),
    operations,
  });
}

/** 返回适合管理员定位字段的六操作中文标签。 */
function getApiAdapterOperationLabel(
  operation: ApiUpstreamAdapterOperationId
): string {
  switch (operation) {
    case "images.generate":
      return "文生图生成";
    case "images.generate.query":
      return "文生图查询";
    case "images.edit":
      return "图生图生成";
    case "images.edit.query":
      return "图生图查询";
    case "videos.generate":
      return "生视频生成";
    case "videos.query":
      return "生视频查询";
  }
}

/** 将仓储保存结果映射为稳定领域错误。 */
function assertMemberSaved(
  result: SaveBackendMemberRepositoryResult
): asserts result is Extract<
  SaveBackendMemberRepositoryResult,
  { status: "saved" }
> {
  switch (result.status) {
    case "saved":
      return;
    case "not_found":
      throw new BackendMemberServiceError("not_found", "媒体后端成员不存在");
    case "already_exists":
      throw new BackendMemberServiceError("conflict", "媒体后端成员 ID 已存在");
    case "type_conflict":
      throw new BackendMemberServiceError(
        "conflict",
        "成员类型不可原地修改，请删除后重新创建"
      );
    case "version_conflict":
      throw new BackendMemberServiceError(
        "conflict",
        "API 账号配置已被其他管理员更新，请刷新后重试"
      );
    case "credential_scope_conflict":
      throw new BackendMemberServiceError(
        "conflict",
        "当前仍有使用旧凭据域的任务或租约，不能切换上游地址或认证方式"
      );
    case "missing_secret":
      throw new BackendMemberServiceError(
        "validation_error",
        "新成员必须提供上游凭据"
      );
    case "unknown_group":
      throw new BackendMemberServiceError(
        "validation_error",
        "选择的媒体后端分组不存在"
      );
  }
}

/**
 * 创建统一成员领域服务。
 *
 * @param dependencies 仓储、ID、时钟和 URL 校验依赖。
 * @returns 无进程缓存且所有写入都委托原子仓储的服务。
 */
export function createBackendMemberService(
  dependencies: BackendMemberServiceDependencies
): BackendMemberService {
  const createId = dependencies.createId ?? nanoid;
  const now = dependencies.now ?? (() => new Date());
  const validateUpstreamUrl =
    dependencies.validateUpstreamUrl ?? parseMediaUpstreamUrl;
  const validateAdapterScript =
    dependencies.validateAdapterScript ?? validateApiUpstreamScript;
  const prepareAdobeDirectCredential =
    dependencies.prepareAdobeDirectCredential ??
    (async (cookie: string, scope?: string) => {
      const direct = await import("@/features/image-generation/adobe-direct");
      return direct.prepareAdobeDirectCredential(cookie, scope);
    });

  return {
    async saveMember(rawInput) {
      let input = backendMemberInputSchema.parse(rawInput);
      if (
        input.type === "adobe" &&
        input.config.mode === "direct" &&
        input.config.cookie !== undefined
      ) {
        input = {
          ...input,
          config: {
            ...input.config,
            cookie: normalizeAdobeDirectCookie(input.config.cookie),
          },
        };
      }
      assertUniqueGroupIds(input.groupIds);
      try {
        if (input.type === "api") {
          await validateUpstreamUrl(input.config.baseUrl);
        } else if (input.config.mode === "gateway") {
          await validateUpstreamUrl(input.config.baseUrl);
        }
      } catch {
        throw new BackendMemberServiceError(
          "validation_error",
          "媒体上游地址无效"
        );
      }

      if (input.type === "api") {
        const adapterDraft = createApiAdapterDraft(input);
        for (const operation of API_UPSTREAM_ADAPTER_OPERATION_IDS) {
          for (const stage of ["request", "response"] as const) {
            const script =
              stage === "request"
                ? adapterDraft.operations[operation].requestScript
                : adapterDraft.operations[operation].responseScript;
            if (!script) continue;
            try {
              await validateAdapterScript(script, operation, stage);
            } catch {
              throw new BackendMemberServiceError(
                "validation_error",
                `${getApiAdapterOperationLabel(operation)}${
                  stage === "request" ? "请求" : "响应"
                }脚本语法无效`
              );
            }
          }
        }
        input = {
          ...input,
          config: {
            ...input.config,
            authentication: adapterDraft.authentication,
            credentialScope: adapterDraft.credentialScope,
            operations: adapterDraft.operations,
          },
        };
      }

      let directCredential: PreparedAdobeDirectCredential | undefined;
      if (
        input.type === "adobe" &&
        input.config.mode === "direct" &&
        input.config.cookie
      ) {
        try {
          directCredential = await prepareAdobeDirectCredential(
            input.config.cookie,
            input.config.scope
          );
        } catch {
          throw new BackendMemberServiceError(
            "validation_error",
            "Adobe Cookie 无法通过账号校验"
          );
        }
      }
      const result = await dependencies.repository.saveMember(
        {
          ...input,
          id: input.id ?? createId(),
          isCreate: input.id === undefined,
          ...(directCredential ? { directCredential } : {}),
        },
        now()
      );
      assertMemberSaved(result);
      return {
        id: result.id,
        ...(result.adapterVersion !== undefined
          ? { adapterVersion: result.adapterVersion }
          : {}),
      };
    },

    async listMembers() {
      return dependencies.repository.listMembers(now());
    },

    /** 校验成员 ID 并清除该成员的暂态运行故障。 */
    async resetMemberStatus(memberId) {
      const id = z.string().trim().min(1).max(128).parse(memberId);
      const result = await dependencies.repository.resetMemberStatus(id, now());
      if (result === "not_found") {
        throw new BackendMemberServiceError("not_found", "媒体后端成员不存在");
      }
      return { success: true };
    },

    /** 校验成员 ID 并原子修改其启用状态。 */
    async setMemberEnabled(memberId, isEnabled) {
      const id = z.string().trim().min(1).max(128).parse(memberId);
      const enabled = z.boolean().parse(isEnabled);
      const result = await dependencies.repository.setMemberEnabled(
        id,
        enabled,
        now()
      );
      if (result === "not_found") {
        throw new BackendMemberServiceError("not_found", "媒体后端成员不存在");
      }
      return { id, isEnabled: enabled };
    },

    async deleteMember(memberId) {
      const id = z.string().trim().min(1).max(128).parse(memberId);
      const result = await dependencies.repository.deleteMember(id, now());
      if (result === "not_found") {
        throw new BackendMemberServiceError("not_found", "媒体后端成员不存在");
      }
      if (result === "busy") {
        throw new BackendMemberServiceError(
          "conflict",
          "成员仍有有效租约或未完成视频任务，只能先停用"
        );
      }
      return { success: true };
    },
  };
}

const existingMemberRowSchema = z.object({
  id: z.string(),
  type: z.enum(["api", "adobe"]),
  is_enabled: z.boolean(),
});

const memberListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["api", "adobe"]),
  group_ids: z.array(z.string()),
  supported_model_ids: z.array(z.string()).min(1),
  content_safety_enabled: z.boolean(),
  is_enabled: z.boolean(),
  always_active: z.boolean(),
  failure_cooldown_enabled: z.boolean(),
  priority: z.coerce.number().int(),
  concurrency: z.coerce.number().int().positive(),
  status: z.string(),
  health_status: z.string(),
  inflight_count: z.coerce.number().int().nonnegative(),
  lease_acquired_count: z.coerce.number().int().nonnegative(),
  last_acquired_at: z.coerce.date().nullable(),
  last_used_at: z.coerce.date().nullable(),
  last_error: z.string().nullable(),
  last_error_at: z.coerce.date().nullable(),
  api_has_key: z.boolean(),
  api_credential_scope: z.string().nullable(),
  api_adapter_version_id: z.string().nullable(),
  api_adapter_revision: z.coerce.number().int().positive().nullable(),
  api_adapter_created_at: z.coerce.date().nullable(),
  api_adapter_configuration: z.unknown().nullable(),
  adobe_mode: z.enum(["gateway", "direct"]).nullable(),
  adobe_base_url: z.string().nullable(),
  adobe_has_key: z.boolean(),
  adobe_has_cookie: z.boolean(),
  adobe_display_name: z.string().nullable(),
  adobe_email: z.string().nullable(),
  adobe_credential_status: z
    .enum(["active", "error", "exhausted", "invalid"])
    .nullable(),
  adobe_last_refresh_at: z.coerce.date().nullable(),
  adobe_last_refresh_error: z.string().nullable(),
  adobe_consecutive_failures: z.coerce.number().int().nonnegative(),
  adobe_firefly_credential_status: z
    .enum(["active", "error", "exhausted", "invalid"])
    .nullable(),
  adobe_firefly_last_refresh_at: z.coerce.date().nullable(),
  adobe_firefly_last_refresh_error: z.string().nullable(),
  adobe_firefly_consecutive_failures: z.coerce.number().int().nonnegative(),
  adobe_credits_total: z.coerce.number().int().nullable(),
  adobe_credits_used: z.coerce.number().int().nullable(),
  adobe_credits_available: z.coerce.number().int().nullable(),
  adobe_credits_updated_at: z.coerce.date().nullable(),
  adobe_credits_error: z.string().nullable(),
  default_ratio: z.string().nullable(),
  default_resolution: z.string().nullable(),
  gpt_image_quality: z.enum(["low", "medium", "high"]).nullable(),
});

/** 把数据库成员行映射为不含 secret 的管理 DTO。 */
function mapMemberListRow(value: unknown): BackendMemberAdminSummary {
  const row = memberListRowSchema.parse(value);
  const common = {
    id: row.id,
    name: row.name,
    type: row.type,
    groupIds: row.group_ids,
    supportedModelIds: row.supported_model_ids,
    contentSafetyEnabled: row.content_safety_enabled,
    isEnabled: row.is_enabled,
    alwaysActive: row.always_active,
    failureCooldownEnabled: row.failure_cooldown_enabled,
    priority: row.priority,
    concurrency: row.concurrency,
    status: row.status,
    healthStatus: row.health_status,
    inflightCount: row.inflight_count,
    leaseAcquiredCount: row.lease_acquired_count,
    lastAcquiredAt: row.last_acquired_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at?.toISOString() ?? null,
  };
  if (row.type === "api") {
    if (
      !row.api_credential_scope ||
      !row.api_adapter_version_id ||
      !row.api_adapter_revision ||
      !row.api_adapter_created_at ||
      !row.api_adapter_configuration
    ) {
      throw new Error("API member is missing its type config");
    }
    const adapter = apiUpstreamAdapterDraftSchema.parse(
      row.api_adapter_configuration
    );
    if (adapter.credentialScope !== row.api_credential_scope) {
      throw new Error("API member credential scope does not match its version");
    }
    return {
      ...common,
      type: "api",
      config: {
        baseUrl: adapter.baseUrl,
        hasApiKey: row.api_has_key,
        useStream: adapter.useStream,
        modelMappings: apiModelMappingsSchema.parse(adapter.modelMappings),
        authentication: adapter.authentication,
        credentialScope: adapter.credentialScope,
        operations: adapter.operations,
        currentAdapterVersion: {
          id: row.api_adapter_version_id,
          revision: row.api_adapter_revision,
          createdAt: row.api_adapter_created_at.toISOString(),
        },
      },
    };
  }
  if (
    !row.adobe_mode ||
    !row.default_ratio ||
    !row.default_resolution ||
    !row.gpt_image_quality
  ) {
    throw new Error("Adobe member is missing its type config");
  }
  if (row.adobe_mode === "direct") {
    if (!row.adobe_has_cookie || !row.adobe_credential_status) {
      throw new Error("Adobe direct member is missing its credential");
    }
    return {
      ...common,
      type: "adobe",
      config: {
        mode: "direct",
        hasCookie: row.adobe_has_cookie,
        displayName: row.adobe_display_name,
        email: row.adobe_email,
        credentialStatus: row.adobe_credential_status,
        lastRefreshAt: row.adobe_last_refresh_at?.toISOString() ?? null,
        lastRefreshError: row.adobe_last_refresh_error,
        consecutiveFailures: row.adobe_consecutive_failures,
        fireflyCredentialStatus: row.adobe_firefly_credential_status,
        fireflyLastRefreshAt:
          row.adobe_firefly_last_refresh_at?.toISOString() ?? null,
        fireflyLastRefreshError: row.adobe_firefly_last_refresh_error,
        fireflyConsecutiveFailures: row.adobe_firefly_consecutive_failures,
        creditsTotal: row.adobe_credits_total,
        creditsUsed: row.adobe_credits_used,
        creditsAvailable: row.adobe_credits_available,
        creditsUpdatedAt: row.adobe_credits_updated_at?.toISOString() ?? null,
        creditsError: row.adobe_credits_error,
        defaultRatio: row.default_ratio,
        defaultResolution: row.default_resolution,
        gptImageQuality: row.gpt_image_quality,
      },
    };
  }
  if (!row.adobe_base_url) {
    throw new Error("Adobe gateway member is missing its base URL");
  }
  return {
    ...common,
    type: "adobe",
    config: {
      mode: "gateway",
      baseUrl: row.adobe_base_url,
      hasApiKey: row.adobe_has_key,
      defaultRatio: row.default_ratio,
      defaultResolution: row.default_resolution,
      gptImageQuality: row.gpt_image_quality,
    },
  };
}

/**
 * 默认 Drizzle 仓储。
 *
 * 动态加载数据库模块，确保服务定义和单元测试保持 DB-free；所有不变量在一个
 * PostgreSQL 事务内检查并写入，避免并发更新留下双类型配置或部分分组关系。
 */
export const defaultBackendMemberRepository: BackendMemberRepository = {
  async saveMember(input, now) {
    const {
      db,
      imageBackendGroup,
      adobeCredentialHealth,
      imageBackendMember,
      imageBackendMemberAdobeConfig,
      imageBackendMemberApiAdapterVersion,
      imageBackendMemberApiConfig,
      imageBackendMemberGroup,
    } = await import("@repo/database");
    return db.transaction(async (transaction) => {
      const existingRows = extractExecuteRows(
        await transaction.execute(sql`
          select id, type, is_enabled
          from image_backend_member
          where id = ${input.id}
          for update
        `)
      );
      const existing = existingRows[0]
        ? existingMemberRowSchema.parse(existingRows[0])
        : null;
      if (input.isCreate && existing) {
        return { status: "already_exists" } as const;
      }
      if (!input.isCreate && !existing) {
        return { status: "not_found" } as const;
      }
      if (existing && existing.type !== input.type) {
        return { status: "type_conflict" } as const;
      }

      const uniqueGroupIds = [...new Set(input.groupIds)];
      const groupRows = await transaction
        .select({ id: imageBackendGroup.id })
        .from(imageBackendGroup)
        .where(inArray(imageBackendGroup.id, uniqueGroupIds));
      if (groupRows.length !== uniqueGroupIds.length) {
        return { status: "unknown_group" } as const;
      }

      let apiKey: string | null = null;
      let currentApiAdapter: {
        id: string;
        revision: number;
        credentialScope: string;
        configuration: Record<string, unknown>;
      } | null = null;
      if (input.type === "api") {
        let existingApiKey: string | null = null;
        if (existing) {
          const [row] = await transaction
            .select({
              apiKey: imageBackendMemberApiConfig.apiKey,
              currentAdapterVersionId:
                imageBackendMemberApiConfig.currentAdapterVersionId,
            })
            .from(imageBackendMemberApiConfig)
            .where(eq(imageBackendMemberApiConfig.memberId, input.id))
            .limit(1);
          existingApiKey = row?.apiKey ?? null;
          if (row) {
            const [version] = await transaction
              .select({
                id: imageBackendMemberApiAdapterVersion.id,
                revision: imageBackendMemberApiAdapterVersion.revision,
                credentialScope:
                  imageBackendMemberApiAdapterVersion.credentialScope,
                configuration:
                  imageBackendMemberApiAdapterVersion.configuration,
              })
              .from(imageBackendMemberApiAdapterVersion)
              .where(
                eq(
                  imageBackendMemberApiAdapterVersion.id,
                  row.currentAdapterVersionId
                )
              )
              .limit(1);
            if (!version) {
              throw new Error("API 成员当前适配版本缺失");
            }
            currentApiAdapter = version;
          }
        }
        apiKey =
          input.config.authentication.mode === "none"
            ? null
            : (input.config.apiKey ?? existingApiKey);
        if (input.config.authentication.mode !== "none" && !apiKey) {
          return { status: "missing_secret" } as const;
        }
      }

      let apiAdapterVersion: {
        id: string;
        revision: number;
        credentialScope: string;
      } | null = null;
      if (input.type === "api") {
        const draft = createApiAdapterDraft(input);
        if (
          input.config.expectedCurrentVersionId !== undefined &&
          input.config.expectedCurrentVersionId !==
            (currentApiAdapter?.id ?? null)
        ) {
          return { status: "version_conflict" } as const;
        }
        const currentDraft = currentApiAdapter
          ? apiUpstreamAdapterDraftSchema.safeParse(
              currentApiAdapter.configuration
            )
          : null;
        const configurationChanged =
          !currentDraft?.success ||
          JSON.stringify(currentDraft.data) !== JSON.stringify(draft);
        if (
          configurationChanged &&
          currentApiAdapter &&
          currentApiAdapter.credentialScope !== draft.credentialScope
        ) {
          const inUse = extractExecuteRows(
            await transaction.execute(sql`
              select 1
              where exists (
                select 1
                from image_backend_member_lease
                where api_adapter_member_id = ${input.id}
                  and expires_at > ${now}
              ) or exists (
                select 1
                from generation
                where api_adapter_member_id = ${input.id}
                  and status = 'pending'
              ) or exists (
                select 1
                from video_generation
                where api_adapter_member_id = ${input.id}
                  and status not in ('completed', 'failed')
              )
              limit 1
            `)
          );
          if (inUse.length > 0) {
            return { status: "credential_scope_conflict" } as const;
          }
        }
        if (configurationChanged) {
          const nextVersion = {
            id: nanoid(),
            memberIdSnapshot: input.id,
            revision: (currentApiAdapter?.revision ?? 0) + 1,
            credentialScope: draft.credentialScope,
            configuration: draft,
            createdAt: now,
          };
          await transaction
            .insert(imageBackendMemberApiAdapterVersion)
            .values(nextVersion);
          apiAdapterVersion = {
            id: nextVersion.id,
            revision: nextVersion.revision,
            credentialScope: nextVersion.credentialScope,
          };
        } else if (currentApiAdapter) {
          apiAdapterVersion = {
            id: currentApiAdapter.id,
            revision: currentApiAdapter.revision,
            credentialScope: currentApiAdapter.credentialScope,
          };
        } else {
          throw new Error("API 成员缺少可保存的适配版本");
        }
      }

      let adobeApiKey: string | null = null;
      if (input.type === "adobe" && input.config.mode === "gateway") {
        if (input.config.apiKey) {
          adobeApiKey = input.config.apiKey;
        } else if (existing) {
          const [row] = await transaction
            .select({ apiKey: imageBackendMemberAdobeConfig.apiKey })
            .from(imageBackendMemberAdobeConfig)
            .where(eq(imageBackendMemberAdobeConfig.memberId, input.id))
            .limit(1);
          adobeApiKey = row?.apiKey ?? null;
        }
        if (!adobeApiKey) return { status: "missing_secret" } as const;
      }

      let directCredentialValues: {
        cookie: string;
        scope: string | null;
        accessToken: string;
        accountUserId: string | null;
        displayName: string | null;
        email: string | null;
        credentialStatus: string;
        tokenExpiresAt: Date | null;
        tokenFails: number;
        lastRefreshAt: Date | null;
        lastRefreshError: string | null;
        nextRefreshAt: Date | null;
        consecutiveFailures: number;
        fireflyAccessToken: string | null;
        fireflyTokenExpiresAt: Date | null;
        fireflyCredentialStatus: string | null;
        fireflyTokenFails: number;
        fireflyLastRefreshAt: Date | null;
        fireflyLastRefreshError: string | null;
        fireflyNextRefreshAt: Date | null;
        fireflyConsecutiveFailures: number;
        creditsTotal: number | null;
        creditsUsed: number | null;
        creditsAvailable: number | null;
        creditsUpdatedAt: Date | null;
        creditsError: string | null;
      } | null = null;
      if (input.type === "adobe" && input.config.mode === "direct") {
        if (input.directCredential && input.config.cookie) {
          directCredentialValues = {
            cookie: input.config.cookie,
            scope: input.config.scope ?? null,
            accessToken: input.directCredential.accessToken,
            accountUserId: input.directCredential.accountUserId,
            displayName: input.directCredential.displayName,
            email: input.directCredential.email,
            credentialStatus: "active",
            tokenExpiresAt: input.directCredential.expiresAt,
            tokenFails: 0,
            lastRefreshAt: now,
            lastRefreshError: null,
            nextRefreshAt: null,
            consecutiveFailures: 0,
            fireflyAccessToken: null,
            fireflyTokenExpiresAt: null,
            fireflyCredentialStatus: null,
            fireflyTokenFails: 0,
            fireflyLastRefreshAt: null,
            fireflyLastRefreshError: null,
            fireflyNextRefreshAt: null,
            fireflyConsecutiveFailures: 0,
            creditsTotal: input.directCredential.creditsTotal,
            creditsUsed: input.directCredential.creditsUsed,
            creditsAvailable: input.directCredential.creditsAvailable,
            creditsUpdatedAt: input.directCredential.creditsUpdatedAt,
            creditsError: input.directCredential.creditsError,
          };
        } else if (existing) {
          const [row] = await transaction
            .select({
              cookie: imageBackendMemberAdobeConfig.cookie,
              scope: imageBackendMemberAdobeConfig.scope,
              accessToken: imageBackendMemberAdobeConfig.accessToken,
              accountUserId: imageBackendMemberAdobeConfig.accountUserId,
              displayName: imageBackendMemberAdobeConfig.displayName,
              email: imageBackendMemberAdobeConfig.email,
              credentialStatus: imageBackendMemberAdobeConfig.credentialStatus,
              tokenExpiresAt: imageBackendMemberAdobeConfig.tokenExpiresAt,
              tokenFails: imageBackendMemberAdobeConfig.tokenFails,
              lastRefreshAt: imageBackendMemberAdobeConfig.lastRefreshAt,
              lastRefreshError: imageBackendMemberAdobeConfig.lastRefreshError,
              nextRefreshAt: imageBackendMemberAdobeConfig.nextRefreshAt,
              consecutiveFailures:
                imageBackendMemberAdobeConfig.consecutiveFailures,
              fireflyAccessToken:
                imageBackendMemberAdobeConfig.fireflyAccessToken,
              fireflyTokenExpiresAt:
                imageBackendMemberAdobeConfig.fireflyTokenExpiresAt,
              fireflyCredentialStatus:
                imageBackendMemberAdobeConfig.fireflyCredentialStatus,
              fireflyTokenFails:
                imageBackendMemberAdobeConfig.fireflyTokenFails,
              fireflyLastRefreshAt:
                imageBackendMemberAdobeConfig.fireflyLastRefreshAt,
              fireflyLastRefreshError:
                imageBackendMemberAdobeConfig.fireflyLastRefreshError,
              fireflyNextRefreshAt:
                imageBackendMemberAdobeConfig.fireflyNextRefreshAt,
              fireflyConsecutiveFailures:
                imageBackendMemberAdobeConfig.fireflyConsecutiveFailures,
              creditsTotal: imageBackendMemberAdobeConfig.creditsTotal,
              creditsUsed: imageBackendMemberAdobeConfig.creditsUsed,
              creditsAvailable: imageBackendMemberAdobeConfig.creditsAvailable,
              creditsUpdatedAt: imageBackendMemberAdobeConfig.creditsUpdatedAt,
              creditsError: imageBackendMemberAdobeConfig.creditsError,
            })
            .from(imageBackendMemberAdobeConfig)
            .where(eq(imageBackendMemberAdobeConfig.memberId, input.id))
            .limit(1);
          if (row?.cookie && row.accessToken && row.credentialStatus) {
            directCredentialValues = {
              ...row,
              cookie: row.cookie,
              accessToken: row.accessToken,
              credentialStatus: row.credentialStatus,
            };
          }
        }
        if (!directCredentialValues) {
          return { status: "missing_secret" } as const;
        }
      }

      const commonValues = {
        name: input.name,
        supportedModelIds: input.supportedModelIds,
        contentSafetyEnabled: input.contentSafetyEnabled,
        isEnabled: input.isEnabled,
        alwaysActive: input.alwaysActive,
        failureCooldownEnabled: input.failureCooldownEnabled,
        priority: input.priority,
        concurrency: input.concurrency,
        updatedAt: now,
      };
      await transaction
        .insert(imageBackendMember)
        .values({
          id: input.id,
          type: input.type,
          ...commonValues,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: imageBackendMember.id,
          set: commonValues,
        });

      if (input.type === "api") {
        if (!apiAdapterVersion) {
          throw new Error("API 成员适配版本未创建");
        }
        await transaction
          .delete(imageBackendMemberAdobeConfig)
          .where(eq(imageBackendMemberAdobeConfig.memberId, input.id));
        await transaction
          .insert(imageBackendMemberApiConfig)
          .values({
            memberId: input.id,
            apiKey,
            currentAdapterVersionId: apiAdapterVersion.id,
            credentialScope: apiAdapterVersion.credentialScope,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: imageBackendMemberApiConfig.memberId,
            set: {
              apiKey,
              currentAdapterVersionId: apiAdapterVersion.id,
              credentialScope: apiAdapterVersion.credentialScope,
              updatedAt: now,
            },
          });
      } else {
        await transaction
          .delete(imageBackendMemberApiConfig)
          .where(eq(imageBackendMemberApiConfig.memberId, input.id));
        await transaction
          .insert(imageBackendMemberAdobeConfig)
          .values({
            memberId: input.id,
            mode: input.config.mode,
            baseUrl:
              input.config.mode === "gateway" ? input.config.baseUrl : null,
            apiKey: input.config.mode === "gateway" ? adobeApiKey : null,
            cookie: directCredentialValues?.cookie ?? null,
            scope: directCredentialValues?.scope ?? null,
            accessToken: directCredentialValues?.accessToken ?? null,
            accountUserId: directCredentialValues?.accountUserId ?? null,
            displayName: directCredentialValues?.displayName ?? null,
            email: directCredentialValues?.email ?? null,
            credentialStatus: directCredentialValues?.credentialStatus ?? null,
            tokenExpiresAt: directCredentialValues?.tokenExpiresAt ?? null,
            tokenFails: directCredentialValues?.tokenFails ?? 0,
            lastRefreshAt: directCredentialValues?.lastRefreshAt ?? null,
            lastRefreshError: directCredentialValues?.lastRefreshError ?? null,
            nextRefreshAt: directCredentialValues?.nextRefreshAt ?? null,
            consecutiveFailures:
              directCredentialValues?.consecutiveFailures ?? 0,
            fireflyAccessToken:
              directCredentialValues?.fireflyAccessToken ?? null,
            fireflyTokenExpiresAt:
              directCredentialValues?.fireflyTokenExpiresAt ?? null,
            fireflyCredentialStatus:
              directCredentialValues?.fireflyCredentialStatus ?? null,
            fireflyTokenFails: directCredentialValues?.fireflyTokenFails ?? 0,
            fireflyLastRefreshAt:
              directCredentialValues?.fireflyLastRefreshAt ?? null,
            fireflyLastRefreshError:
              directCredentialValues?.fireflyLastRefreshError ?? null,
            fireflyNextRefreshAt:
              directCredentialValues?.fireflyNextRefreshAt ?? null,
            fireflyConsecutiveFailures:
              directCredentialValues?.fireflyConsecutiveFailures ?? 0,
            creditsTotal: directCredentialValues?.creditsTotal ?? null,
            creditsUsed: directCredentialValues?.creditsUsed ?? null,
            creditsAvailable: directCredentialValues?.creditsAvailable ?? null,
            creditsUpdatedAt: directCredentialValues?.creditsUpdatedAt ?? null,
            creditsError: directCredentialValues?.creditsError ?? null,
            defaultRatio: input.config.defaultRatio,
            defaultResolution: input.config.defaultResolution,
            gptImageQuality: input.config.gptImageQuality,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: imageBackendMemberAdobeConfig.memberId,
            set: {
              mode: input.config.mode,
              baseUrl:
                input.config.mode === "gateway" ? input.config.baseUrl : null,
              apiKey: input.config.mode === "gateway" ? adobeApiKey : null,
              cookie: directCredentialValues?.cookie ?? null,
              scope: directCredentialValues?.scope ?? null,
              accessToken: directCredentialValues?.accessToken ?? null,
              accountUserId: directCredentialValues?.accountUserId ?? null,
              displayName: directCredentialValues?.displayName ?? null,
              email: directCredentialValues?.email ?? null,
              credentialStatus:
                directCredentialValues?.credentialStatus ?? null,
              tokenExpiresAt: directCredentialValues?.tokenExpiresAt ?? null,
              tokenFails: directCredentialValues?.tokenFails ?? 0,
              lastRefreshAt: directCredentialValues?.lastRefreshAt ?? null,
              lastRefreshError:
                directCredentialValues?.lastRefreshError ?? null,
              nextRefreshAt: directCredentialValues?.nextRefreshAt ?? null,
              consecutiveFailures:
                directCredentialValues?.consecutiveFailures ?? 0,
              fireflyAccessToken:
                directCredentialValues?.fireflyAccessToken ?? null,
              fireflyTokenExpiresAt:
                directCredentialValues?.fireflyTokenExpiresAt ?? null,
              fireflyCredentialStatus:
                directCredentialValues?.fireflyCredentialStatus ?? null,
              fireflyTokenFails: directCredentialValues?.fireflyTokenFails ?? 0,
              fireflyLastRefreshAt:
                directCredentialValues?.fireflyLastRefreshAt ?? null,
              fireflyLastRefreshError:
                directCredentialValues?.fireflyLastRefreshError ?? null,
              fireflyNextRefreshAt:
                directCredentialValues?.fireflyNextRefreshAt ?? null,
              fireflyConsecutiveFailures:
                directCredentialValues?.fireflyConsecutiveFailures ?? 0,
              creditsTotal: directCredentialValues?.creditsTotal ?? null,
              creditsUsed: directCredentialValues?.creditsUsed ?? null,
              creditsAvailable:
                directCredentialValues?.creditsAvailable ?? null,
              creditsUpdatedAt:
                directCredentialValues?.creditsUpdatedAt ?? null,
              creditsError: directCredentialValues?.creditsError ?? null,
              defaultRatio: input.config.defaultRatio,
              defaultResolution: input.config.defaultResolution,
              gptImageQuality: input.config.gptImageQuality,
              updatedAt: now,
            },
          });

        if (input.config.mode === "direct") {
          await transaction
            .insert(adobeCredentialHealth)
            .values({
              memberId: input.id,
              status: "pending",
              nextCheckAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing();
          if (
            existing &&
            (Boolean(input.directCredential) ||
              existing.is_enabled !== input.isEnabled)
          ) {
            // WHY：普通成员编辑只使事务外旧评估失效，不能清除隔离；隔离恢复必须
            // 经过专用同账号重新授权流程，避免替换成另一个账号绕过身份约束。
            await transaction
              .update(adobeCredentialHealth)
              .set({
                ...(input.directCredential
                  ? {
                      credentialRevision: sql`${adobeCredentialHealth.credentialRevision} + 1`,
                    }
                  : {}),
                ...(existing.is_enabled !== input.isEnabled
                  ? {
                      memberEnableRevision: sql`${adobeCredentialHealth.memberEnableRevision} + 1`,
                    }
                  : {}),
                claimToken: null,
                claimExpiresAt: null,
                evaluationDeadlineAt: null,
                nextCheckAt: now,
                updatedAt: now,
              })
              .where(eq(adobeCredentialHealth.memberId, input.id));
          }
        } else {
          await transaction
            .delete(adobeCredentialHealth)
            .where(eq(adobeCredentialHealth.memberId, input.id));
        }
      }

      await transaction
        .delete(imageBackendMemberGroup)
        .where(eq(imageBackendMemberGroup.memberId, input.id));
      await transaction.insert(imageBackendMemberGroup).values(
        uniqueGroupIds.map((groupId) => ({
          id: nanoid(),
          memberId: input.id,
          groupId,
          createdAt: now,
        }))
      );
      return {
        status: "saved",
        id: input.id,
        ...(apiAdapterVersion
          ? {
              adapterVersion: {
                id: apiAdapterVersion.id,
                revision: apiAdapterVersion.revision,
              },
            }
          : {}),
      } as const;
    });
  },

  async listMembers(now) {
    const { db } = await import("@repo/database");
    const rows = extractExecuteRows(
      await db.execute(sql`
        select
          member.id,
          member.name,
          member.type,
          coalesce(
            json_agg(
              distinct membership.group_id
              order by membership.group_id
            )
              filter (where membership.group_id is not null),
            '[]'::json
          ) as group_ids,
          member.supported_model_ids,
          member.content_safety_enabled,
          member.is_enabled,
          member.always_active,
          member.failure_cooldown_enabled,
          member.priority,
          member.concurrency,
          member.status,
          member.health_status,
          count(distinct lease.id)::integer as inflight_count,
          member.lease_acquired_count,
          member.last_acquired_at,
          member.last_used_at,
          member.last_error,
          member.last_error_at,
          (api.api_key is not null) as api_has_key,
          api.credential_scope as api_credential_scope,
          api.current_adapter_version_id as api_adapter_version_id,
          api_version.revision as api_adapter_revision,
          api_version.created_at as api_adapter_created_at,
          api_version.configuration as api_adapter_configuration,
          adobe.mode as adobe_mode,
          adobe.base_url as adobe_base_url,
          (adobe.api_key is not null) as adobe_has_key,
          (adobe.cookie is not null) as adobe_has_cookie,
          adobe.display_name as adobe_display_name,
          adobe.email as adobe_email,
          adobe.credential_status as adobe_credential_status,
          adobe.last_refresh_at as adobe_last_refresh_at,
          adobe.last_refresh_error as adobe_last_refresh_error,
          adobe.consecutive_failures as adobe_consecutive_failures,
          adobe.firefly_credential_status as adobe_firefly_credential_status,
          adobe.firefly_last_refresh_at as adobe_firefly_last_refresh_at,
          adobe.firefly_last_refresh_error as adobe_firefly_last_refresh_error,
          adobe.firefly_consecutive_failures as adobe_firefly_consecutive_failures,
          adobe.credits_total as adobe_credits_total,
          adobe.credits_used as adobe_credits_used,
          adobe.credits_available as adobe_credits_available,
          adobe.credits_updated_at as adobe_credits_updated_at,
          adobe.credits_error as adobe_credits_error,
          adobe.default_ratio,
          adobe.default_resolution,
          adobe.gpt_image_quality
        from image_backend_member as member
        left join image_backend_member_group as membership
          on membership.member_id = member.id
        left join image_backend_member_lease as lease
          on lease.member_id = member.id
          and lease.expires_at > ${now}
        left join image_backend_member_api_config as api
          on api.member_id = member.id
        left join image_backend_member_api_adapter_version as api_version
          on api_version.member_id_snapshot = api.member_id
          and api_version.id = api.current_adapter_version_id
        left join image_backend_member_adobe_config as adobe
          on adobe.member_id = member.id
        group by member.id, api.member_id, api_version.id, adobe.member_id
        order by member.priority asc, member.id asc
      `)
    );
    return rows.map(mapMemberListRow);
  },

  /** 原子重置调度健康字段；凭据、累计指标和有效租约保持原样。 */
  async resetMemberStatus(memberId, now) {
    const { db, imageBackendMember } = await import("@repo/database");
    const reset = await db
      .update(imageBackendMember)
      .set({
        status: "active",
        healthStatus: "healthy",
        errorEwma: 0,
        successStreak: 0,
        failStreak: 0,
        cooldownUntil: null,
        lastObservedAt: now,
        lastError: null,
        lastErrorAt: null,
        updatedAt: now,
      })
      .where(eq(imageBackendMember.id, memberId))
      .returning({ id: imageBackendMember.id });
    return reset.length > 0 ? "reset" : "not_found";
  },

  /** 原子修改成员启用状态；当前租约继续由调度器按原有生命周期处理。 */
  async setMemberEnabled(memberId, isEnabled, now) {
    const { adobeCredentialHealth, db, imageBackendMember } = await import(
      "@repo/database"
    );
    return db.transaction(async (transaction) => {
      const updated = await transaction
        .update(imageBackendMember)
        .set({ isEnabled, updatedAt: now })
        .where(eq(imageBackendMember.id, memberId))
        .returning({ id: imageBackendMember.id });
      if (updated.length === 0) return "not_found";
      // 启停 revision 与成员启用状态同事务递增；清除旧 claim 使停用中途返回的
      // 评估在提交 CAS 时落为 discarded，而不是覆盖重新启用后的新状态。
      await transaction
        .update(adobeCredentialHealth)
        .set({
          memberEnableRevision: sql`${adobeCredentialHealth.memberEnableRevision} + 1`,
          claimToken: null,
          claimExpiresAt: null,
          evaluationDeadlineAt: null,
          ...(isEnabled ? { nextCheckAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(adobeCredentialHealth.memberId, memberId));
      return "updated";
    });
  },

  async deleteMember(memberId, now) {
    const { db, imageBackendMember } = await import("@repo/database");
    return db.transaction(async (transaction) => {
      const existing = extractExecuteRows(
        await transaction.execute(sql`
          select id
          from image_backend_member
          where id = ${memberId}
          for update
        `)
      )[0];
      if (!existing) return "not_found";
      const busyRows = extractExecuteRows(
        await transaction.execute(sql`
          select 1
          where exists (
            select 1
            from image_backend_member_lease
            where member_id = ${memberId}
              and expires_at > ${now}
          ) or exists (
            select 1
            from generation
            where api_adapter_member_id = ${memberId}
              and status = 'pending'
          ) or exists (
            select 1
            from video_generation
            where backend_member_id = ${memberId}
              and status not in ('completed', 'failed')
          )
          limit 1
        `)
      );
      if (busyRows.length > 0) return "busy";
      const deleted = await transaction
        .delete(imageBackendMember)
        .where(eq(imageBackendMember.id, memberId))
        .returning({ id: imageBackendMember.id });
      return deleted.length > 0 ? "deleted" : "not_found";
    });
  },
};

/** 默认生产成员服务。 */
export const backendMemberService = createBackendMemberService({
  repository: defaultBackendMemberRepository,
});
