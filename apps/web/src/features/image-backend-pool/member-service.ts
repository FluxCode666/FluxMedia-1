/**
 * 统一媒体后端成员服务。
 *
 * 职责：校验 `api | adobe` 成员契约和出站 URL，在单一仓储事务中保存公共成员、
 * 恰好一个类型配置及全部分组关系，并提供脱敏管理快照与安全删除。
 * 使用方：UOL pool operations 与管理后台；secret 永不出现在读取 DTO 中。
 */
import type { BackendMemberInput } from "@repo/shared/image-backend/member-contract";
import { backendMemberInputSchema } from "@repo/shared/image-backend/member-contract";
import { requestParameterMappingsSchema } from "@repo/shared/image-backend/request-parameter-mapping";
import { eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

import { assertSafeMediaUpstreamUrl } from "./outbound-url-security";

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

/** 已补齐稳定 ID 的统一成员保存输入。 */
export type PersistedBackendMemberInput = BackendMemberInput & {
  id: string;
  isCreate: boolean;
};

/** 脱敏 API Images 配置。 */
export interface RedactedApiMemberConfig {
  baseUrl: string;
  hasApiKey: boolean;
  useStream: boolean;
  parameterMappings: Array<{
    source: string;
    target: string;
    mode: "copy" | "move";
  }>;
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
}

/** 管理后台统一成员列表项；类型与专属配置保持可判别关联。 */
export type BackendMemberAdminSummary = BackendMemberAdminSummaryBase &
  (
    | { type: "api"; config: RedactedApiMemberConfig }
    | { type: "adobe"; config: RedactedAdobeMemberConfig }
  );

/** 原子保存仓储返回的稳定结果。 */
export type SaveBackendMemberRepositoryResult =
  | { status: "saved"; id: string }
  | { status: "not_found" }
  | { status: "already_exists" }
  | { status: "type_conflict" }
  | { status: "missing_secret" }
  | { status: "unknown_group" };

/** 安全删除仓储返回的稳定结果。 */
export type DeleteBackendMemberRepositoryResult =
  | "deleted"
  | "not_found"
  | "busy";

/** 成员服务依赖的事务仓储端口。 */
export interface BackendMemberRepository {
  saveMember(
    input: PersistedBackendMemberInput,
    now: Date
  ): Promise<SaveBackendMemberRepositoryResult>;
  listMembers(now: Date): Promise<BackendMemberAdminSummary[]>;
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
}

/** 统一成员服务公开接口。 */
export interface BackendMemberService {
  saveMember(input: unknown): Promise<{ id: string }>;
  listMembers(): Promise<BackendMemberAdminSummary[]>;
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

/** 将仓储保存结果映射为稳定领域错误。 */
function assertMemberSaved(
  result: SaveBackendMemberRepositoryResult
): asserts result is { status: "saved"; id: string } {
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
    dependencies.validateUpstreamUrl ?? assertSafeMediaUpstreamUrl;

  return {
    async saveMember(rawInput) {
      const input = backendMemberInputSchema.parse(rawInput);
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
          "媒体上游地址不符合安全策略"
        );
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
      return { id: result.id };
    },

    async listMembers() {
      return dependencies.repository.listMembers(now());
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
  api_base_url: z.string().nullable(),
  api_has_key: z.boolean(),
  api_use_stream: z.boolean().nullable(),
  parameter_mappings: z.unknown().nullable(),
  adobe_mode: z.enum(["gateway", "direct"]).nullable(),
  adobe_base_url: z.string().nullable(),
  adobe_has_key: z.boolean(),
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
  };
  if (row.type === "api") {
    if (!row.api_base_url) {
      throw new Error("API member is missing its type config");
    }
    return {
      ...common,
      type: "api",
      config: {
        baseUrl: row.api_base_url,
        hasApiKey: row.api_has_key,
        useStream: row.api_use_stream ?? false,
        parameterMappings: requestParameterMappingsSchema.parse(
          row.parameter_mappings ?? []
        ),
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
    return {
      ...common,
      type: "adobe",
      config: {
        mode: "direct",
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
      imageBackendMember,
      imageBackendMemberAdobeConfig,
      imageBackendMemberApiConfig,
      imageBackendMemberGroup,
    } = await import("@repo/database");
    return db.transaction(async (transaction) => {
      const existingRows = extractExecuteRows(
        await transaction.execute(sql`
          select id, type
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
      if (input.type === "api") {
        if (input.config.apiKey) {
          apiKey = input.config.apiKey;
        } else if (existing) {
          const [row] = await transaction
            .select({ apiKey: imageBackendMemberApiConfig.apiKey })
            .from(imageBackendMemberApiConfig)
            .where(eq(imageBackendMemberApiConfig.memberId, input.id))
            .limit(1);
          apiKey = row?.apiKey ?? null;
        }
        if (!apiKey) return { status: "missing_secret" } as const;
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
        await transaction
          .delete(imageBackendMemberAdobeConfig)
          .where(eq(imageBackendMemberAdobeConfig.memberId, input.id));
        await transaction
          .insert(imageBackendMemberApiConfig)
          .values({
            memberId: input.id,
            baseUrl: input.config.baseUrl,
            apiKey,
            useStream: input.config.useStream,
            parameterMappings: input.config.parameterMappings,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: imageBackendMemberApiConfig.memberId,
            set: {
              baseUrl: input.config.baseUrl,
              apiKey,
              useStream: input.config.useStream,
              parameterMappings: input.config.parameterMappings,
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
              defaultRatio: input.config.defaultRatio,
              defaultResolution: input.config.defaultResolution,
              gptImageQuality: input.config.gptImageQuality,
              updatedAt: now,
            },
          });
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
      return { status: "saved", id: input.id } as const;
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
          api.base_url as api_base_url,
          (api.api_key is not null) as api_has_key,
          api.use_stream as api_use_stream,
          api.parameter_mappings,
          adobe.mode as adobe_mode,
          adobe.base_url as adobe_base_url,
          (adobe.api_key is not null) as adobe_has_key,
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
        left join image_backend_member_adobe_config as adobe
          on adobe.member_id = member.id
        group by member.id, api.member_id, adobe.member_id
        order by member.priority asc, member.id asc
      `)
    );
    return rows.map(mapMemberListRow);
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
