/**
 * 统一 API 媒体后端成员服务。
 *
 * 职责：校验 API 成员契约和 HTTP(S) URL，在单一仓储事务中保存公共成员、配置及
 * 全部分组关系，并提供脱敏管理快照、启用状态修改与安全删除。
 * 使用方：UOL pool operations 与管理后台；secret 永不出现在读取 DTO 中。
 */
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
import type { ImageSizeConfigSnapshot } from "@repo/shared/image-backend/image-size-config";
import type { BackendMemberInput } from "@repo/shared/image-backend/member-contract";
import {
  backendMemberInputSchema,
  backendModelResolutionCapabilitiesSchema,
} from "@repo/shared/image-backend/member-contract";
import { eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import { validateApiUpstreamScript } from "./api-upstream-script-runtime";
import {
  canonicalizeImageSizeConfigSnapshot,
  IMAGE_SIZE_CONFIG_BINDING_LOCK_QUERY,
} from "./image-size-config-binding";
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

/** 已补齐稳定 ID 的 API 成员保存输入。 */
export type PersistedBackendMemberInput = BackendMemberInput & {
  id: string;
  isCreate: boolean;
};

/** 脱敏 API 媒体配置。 */
export interface RedactedApiMemberConfig {
  baseUrl: string;
  hasApiKey: boolean;
  useStream: boolean;
  /** 图生图参考图是否先转存并转换为绝对公网 URL。 */
  convertReferenceImagesToPublicUrl?: boolean;
  videoSubmissionRetryCount: number;
  videoProtocolMode: ApiUpstreamAdapterDraft["videoProtocolMode"];
  /** 旧适配版本的账号级能力，仅用于兼容读取。 */
  videoInputCapabilities: ApiUpstreamAdapterDraft["videoInputCapabilities"];
  videoInputCapabilitiesByModel: ApiUpstreamAdapterDraft["videoInputCapabilitiesByModel"];
  modelMappings: ApiModelMapping[];
  authentication?: ApiUpstreamAdapterDraft["authentication"];
  credentialScope?: string;
  operations?: ApiUpstreamAdapterDraft["operations"];
  imageSizeConfig?: ApiUpstreamAdapterDraft["imageSizeConfig"];
  currentAdapterVersion?: {
    id: string;
    revision: number;
    createdAt: string;
  } | null;
}

/** 管理后台统一成员列表项的公共字段。 */
interface BackendMemberAdminSummaryBase {
  id: string;
  name: string;
  groupIds: string[];
  supportedModelIds: string[];
  supportedResolutionsByModel?: Record<string, string[]>;
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
  createdAt: string;
  lastAcquiredAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** 管理后台统一成员列表项；类型与专属配置保持可判别关联。 */
export type BackendMemberAdminSummary = BackendMemberAdminSummaryBase & {
  type: "api";
  config: RedactedApiMemberConfig;
};

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
  | { status: "unknown_group" }
  | { status: "unknown_image_size_config" };

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
  loadImageSizeConfig?: (id: string) => Promise<ImageSizeConfigSnapshot | null>;
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
export function createApiAdapterDraft(
  input: Extract<BackendMemberInput, { type: "api" }>,
  imageSizeConfig?: ImageSizeConfigSnapshot | null
): ApiUpstreamAdapterDraft {
  const operations = structuredClone(input.config.operations);
  return apiUpstreamAdapterDraftSchema.parse({
    baseUrl: input.config.baseUrl,
    useStream: input.config.useStream,
    imageSizeConfig: imageSizeConfig ?? null,
    convertReferenceImagesToPublicUrl:
      input.config.convertReferenceImagesToPublicUrl ?? false,
    videoSubmissionRetryCount: input.config.videoSubmissionRetryCount,
    videoProtocolMode: input.config.videoProtocolMode,
    videoInputCapabilities: input.config.videoInputCapabilities,
    videoInputCapabilitiesByModel: input.config.videoInputCapabilitiesByModel,
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
    case "unknown_image_size_config":
      throw new BackendMemberServiceError(
        "validation_error",
        "尺寸配置集不存在"
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
  return {
    async saveMember(rawInput) {
      let input = backendMemberInputSchema.parse(rawInput);
      let imageSizeConfigSnapshot: ImageSizeConfigSnapshot | null = null;
      assertUniqueGroupIds(input.groupIds);
      try {
        await validateUpstreamUrl(input.config.baseUrl);
      } catch {
        throw new BackendMemberServiceError(
          "validation_error",
          "媒体上游地址无效"
        );
      }

      if (input.type === "api") {
        imageSizeConfigSnapshot = input.config.imageSizeConfigId
          ? await (dependencies.loadImageSizeConfig?.(
              input.config.imageSizeConfigId
            ) ?? Promise.resolve(null))
          : null;
        if (input.config.imageSizeConfigId && !imageSizeConfigSnapshot) {
          throw new BackendMemberServiceError(
            "validation_error",
            "尺寸配置集不存在"
          );
        }
        const adapterDraft = createApiAdapterDraft(
          input,
          imageSizeConfigSnapshot
        );
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

      const result = await dependencies.repository.saveMember(
        {
          ...input,
          id: input.id ?? createId(),
          isCreate: input.id === undefined,
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
  type: z.literal("api"),
  is_enabled: z.boolean(),
});

const memberListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal("api"),
  group_ids: z.array(z.string()),
  supported_model_ids: z.array(z.string()).min(1),
  supported_resolutions_by_model: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .default({}),
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
  member_created_at: z.coerce.date(),
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
    supportedResolutionsByModel: backendModelResolutionCapabilitiesSchema.parse(
      row.supported_resolutions_by_model
    ),
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
    createdAt: row.member_created_at.toISOString(),
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
        convertReferenceImagesToPublicUrl:
          adapter.convertReferenceImagesToPublicUrl ?? false,
        videoSubmissionRetryCount: adapter.videoSubmissionRetryCount,
        videoProtocolMode: adapter.videoProtocolMode,
        videoInputCapabilities: adapter.videoInputCapabilities,
        videoInputCapabilitiesByModel: adapter.videoInputCapabilitiesByModel,
        modelMappings: apiModelMappingsSchema.parse(adapter.modelMappings),
        authentication: adapter.authentication,
        credentialScope: adapter.credentialScope,
        operations: adapter.operations,
        imageSizeConfig: adapter.imageSizeConfig ?? null,
        currentAdapterVersion: {
          id: row.api_adapter_version_id,
          revision: row.api_adapter_revision,
          createdAt: row.api_adapter_created_at.toISOString(),
        },
      },
    };
  }
  throw new Error("Unsupported backend member type");
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
      imageBackendMember,
      imageBackendMemberApiAdapterVersion,
      imageBackendMemberApiConfig,
      imageBackendMemberGroup,
      imageSizeConfig,
      imageSizeConfigMapping,
    } = await import("@repo/database");
    return db.transaction(async (transaction) => {
      await transaction.execute(IMAGE_SIZE_CONFIG_BINDING_LOCK_QUERY);
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
        let authoritativeImageSizeConfig: ImageSizeConfigSnapshot | null = null;
        if (input.config.imageSizeConfigId) {
          const [config] = await transaction
            .select({ id: imageSizeConfig.id, name: imageSizeConfig.name })
            .from(imageSizeConfig)
            .where(eq(imageSizeConfig.id, input.config.imageSizeConfigId))
            .limit(1);
          if (!config) {
            return { status: "unknown_image_size_config" } as const;
          }
          const mappings = await transaction
            .select({
              resolution: imageSizeConfigMapping.resolution,
              aspectRatio: imageSizeConfigMapping.aspectRatio,
              size: imageSizeConfigMapping.size,
            })
            .from(imageSizeConfigMapping)
            .where(eq(imageSizeConfigMapping.configId, config.id));
          authoritativeImageSizeConfig = canonicalizeImageSizeConfigSnapshot({
            ...config,
            mappings,
          });
        }
        const draft = createApiAdapterDraft(
          input,
          authoritativeImageSizeConfig
        );
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

      const commonValues = {
        name: input.name,
        supportedModelIds: input.supportedModelIds,
        supportedResolutionsByModel: input.supportedResolutionsByModel ?? {},
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

      if (!apiAdapterVersion) {
        throw new Error("API 成员适配版本未创建");
      }
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
          member.supported_resolutions_by_model,
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
          member.created_at as member_created_at,
          member.last_acquired_at,
          member.last_used_at,
          member.last_error,
          member.last_error_at,
          (api.api_key is not null) as api_has_key,
          api.credential_scope as api_credential_scope,
          api.current_adapter_version_id as api_adapter_version_id,
          api_version.revision as api_adapter_revision,
          api_version.created_at as api_adapter_created_at,
          api_version.configuration as api_adapter_configuration
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
        group by member.id, api.member_id, api_version.id
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
    const { db, imageBackendMember } = await import("@repo/database");
    const updated = await db
      .update(imageBackendMember)
      .set({ isEnabled, updatedAt: now })
      .where(eq(imageBackendMember.id, memberId))
      .returning({ id: imageBackendMember.id });
    return updated.length > 0 ? "updated" : "not_found";
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
  async loadImageSizeConfig(id) {
    const { getImageSizeConfigSnapshot } = await import(
      "./image-size-config-service"
    );
    return getImageSizeConfigSnapshot(id);
  },
});
