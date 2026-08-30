/**
 * 统一媒体后端号池的 PostgreSQL 仓储。
 *
 * 职责：在单一事务中读取调度策略、清理过期租约、锁定并排序合格成员、创建租约，
 * 并通过 owner token 的比较交换语义完成续租、接管和释放。
 * 使用方：统一号池 runtime-service；单元测试通过事务端口注入验证 SQL 与并发边界。
 * 关键依赖：Drizzle 参数化 SQL、共享 scheduling-policy、Zod 数据库行校验。
 */
import {
  type BackendSchedulingCandidate,
  type BackendSchedulingStrategy,
  normalizeBackendSchedulingStrategy,
  sortBackendSchedulingCandidates,
} from "@repo/shared/image-backend/scheduling-policy";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";

/** 调度策略在 system_setting 中的唯一键名。 */
export const IMAGE_BACKEND_SCHEDULING_STRATEGY_SETTING_KEY =
  "IMAGE_BACKEND_SCHEDULING_STRATEGY";

/** 当前统一成员状态中不可再参与调度的终态。 */
export const TERMINAL_BACKEND_MEMBER_STATUSES = ["error"] as const;

const identifierSchema = z.string().trim().min(1).max(128);
const ownerTokenSchema = z.string().trim().min(1).max(512);

const strategyRowSchema = z.object({ value: z.unknown() });

const lockedMemberRowSchema = z
  .object({
    id: identifierSchema,
    type: z.literal("api"),
    name: z.string().min(1).max(120),
    supported_model_ids: z.array(z.string().trim().min(1)).min(1),
    supported_resolutions_by_model: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .default({}),
    content_safety_enabled: z.boolean(),
    is_enabled: z.boolean(),
    priority: z.coerce.number().int().min(0),
    concurrency: z.coerce.number().int().positive(),
    lease_acquired_count: z.coerce.number().int().min(0),
    status: z.string().min(1).max(80),
    health_status: z.enum(["healthy", "degraded", "unhealthy"]),
    last_acquired_at: z.coerce.date().nullable(),
    last_used_at: z.coerce.date().nullable(),
    cooldown_until: z.coerce.date().nullable(),
    api_adapter_member_id: identifierSchema.nullable(),
    api_adapter_version_id: identifierSchema.nullable(),
  })
  .superRefine((row, context) => {
    const hasMember = row.api_adapter_member_id !== null;
    const hasVersion = row.api_adapter_version_id !== null;
    if (hasMember !== hasVersion) {
      context.addIssue({
        code: "custom",
        message: "API adapter ownership pair must be complete",
      });
    }
    if (row.type === "api" && !hasMember) {
      context.addIssue({
        code: "custom",
        message: "API member must have a current adapter version",
      });
    }
  });

const activeLeaseCountRowSchema = z.object({
  member_id: identifierSchema,
  inflight_count: z.coerce.number().int().min(0),
});

const leaseRowSchema = z
  .object({
    id: identifierSchema,
    member_id: identifierSchema,
    owner_token: ownerTokenSchema,
    api_adapter_member_id: identifierSchema.nullable(),
    api_adapter_version_id: identifierSchema.nullable(),
    expires_at: z.coerce.date(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .superRefine((row, context) => {
    if (
      (row.api_adapter_member_id === null) !==
      (row.api_adapter_version_id === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "API adapter ownership pair must be complete",
      });
    }
  });

const mutationIdRowSchema = z.object({ id: identifierSchema });

const acquireLeaseInputSchema = z
  .object({
    groupId: identifierSchema,
    requestedModel: z.string().trim().min(1).max(240),
    requestedResolution: z.string().trim().min(1).max(32).optional(),
    excludedMemberIds: z.array(identifierSchema).max(1_000).default([]),
    requiredMemberId: identifierSchema.optional(),
    requiredMemberType: z.literal("api").optional(),
    requiredApiAdapterMemberId: identifierSchema.optional(),
    requiredApiAdapterVersionId: identifierSchema.optional(),
    requiresContentSafety: z.boolean().default(false),
    requiredVideoInputCapabilities: z
      .object({
        referenceVideos: z.boolean().default(false),
        referenceAudios: z.boolean().default(false),
      })
      .default({ referenceVideos: false, referenceAudios: false }),
    leaseId: identifierSchema,
    ownerToken: ownerTokenSchema,
    now: z.date(),
    expiresAt: z.date(),
  })
  .strict()
  .refine((input) => input.expiresAt.getTime() > input.now.getTime(), {
    message: "Lease expiration must be later than acquisition time",
    path: ["expiresAt"],
  })
  .superRefine((input, context) => {
    const hasAdapterMember = input.requiredApiAdapterMemberId !== undefined;
    const hasAdapterVersion = input.requiredApiAdapterVersionId !== undefined;
    if (hasAdapterMember !== hasAdapterVersion) {
      context.addIssue({
        code: "custom",
        message: "Fixed API adapter ownership pair must be complete",
      });
    }
    if (
      hasAdapterMember &&
      (input.requiredMemberType !== "api" ||
        input.requiredMemberId !== input.requiredApiAdapterMemberId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Fixed API adapter must belong to the required API member",
      });
    }
  });

const renewLeaseInputSchema = z
  .object({
    leaseId: identifierSchema,
    ownerToken: ownerTokenSchema,
    now: z.date(),
    expiresAt: z.date(),
  })
  .strict()
  .refine((input) => input.expiresAt.getTime() > input.now.getTime(), {
    message: "Lease expiration must be later than renewal time",
    path: ["expiresAt"],
  });

const takeoverLeaseInputSchema = z
  .object({
    leaseId: identifierSchema,
    memberId: identifierSchema,
    currentOwnerToken: ownerTokenSchema,
    nextOwnerToken: ownerTokenSchema,
    apiAdapterMemberId: identifierSchema.nullable().optional(),
    apiAdapterVersionId: identifierSchema.nullable().optional(),
    now: z.date(),
    expiresAt: z.date(),
  })
  .strict()
  .refine((input) => input.currentOwnerToken !== input.nextOwnerToken, {
    message: "Lease takeover requires a different owner token",
    path: ["nextOwnerToken"],
  })
  .refine((input) => input.expiresAt.getTime() > input.now.getTime(), {
    message: "Lease expiration must be later than takeover time",
    path: ["expiresAt"],
  })
  .superRefine((input, context) => {
    const hasAdapterMember =
      input.apiAdapterMemberId !== undefined &&
      input.apiAdapterMemberId !== null;
    const hasAdapterVersion =
      input.apiAdapterVersionId !== undefined &&
      input.apiAdapterVersionId !== null;
    if (hasAdapterMember !== hasAdapterVersion) {
      context.addIssue({
        code: "custom",
        message: "API adapter ownership pair must be complete",
      });
    }
  });

const releaseLeaseInputSchema = z
  .object({
    leaseId: identifierSchema,
    ownerToken: ownerTokenSchema,
  })
  .strict();

/** 仓储在锁定事务中排序所需的统一成员事实。 */
interface BackendAcquireCandidate extends BackendSchedulingCandidate {
  groupIds: readonly string[];
  supportedModelIds: readonly string[];
  supportedResolutionsByModel: Readonly<Record<string, readonly string[]>>;
  isEnabled: boolean;
  contentSafetyEnabled: boolean;
  cooldownUntil: Date | null;
  hasTerminalError: boolean;
}

/** 统一成员在获租事务中的完整候选快照。 */
export interface LockedBackendMemberCandidate extends BackendAcquireCandidate {
  type: "api";
  name: string;
  status: string;
  healthStatus: "healthy" | "degraded" | "unhealthy";
}

/** 数据库中的统一成员租约。 */
export interface BackendMemberLease {
  id: string;
  memberId: string;
  ownerToken: string;
  apiAdapterMemberId: string | null;
  apiAdapterVersionId: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** 一次原子获租返回的策略、成员和租约快照。 */
export interface AcquiredBackendMemberLease {
  strategy: BackendSchedulingStrategy;
  member: LockedBackendMemberCandidate;
  lease: BackendMemberLease;
  eligibleCandidateCount: number;
}

/** 获租结果同时保留无候选与容量拒绝，供运行时写入稳定调度指标。 */
export type AcquireBackendMemberLeaseResult =
  | { status: "acquired"; acquisition: AcquiredBackendMemberLease }
  | {
      status: "no_candidate";
      strategy: BackendSchedulingStrategy;
      eligibleCandidateCount: 0;
    }
  | {
      status: "capacity_rejected";
      strategy: BackendSchedulingStrategy;
      eligibleCandidateCount: number;
    };

/** 原子获租输入；ID、owner token 与时钟由 scheduler 显式提供，便于跨 worker 交接。 */
export type AcquireBackendMemberLeaseInput = z.input<
  typeof acquireLeaseInputSchema
>;

/** 同一 owner 对仍有效租约续期的输入。 */
export type RenewBackendMemberLeaseInput = z.input<
  typeof renewLeaseInputSchema
>;

/**
 * 通过 owner token 比较交换恢复租约。
 *
 * 已过期租约可由持久任务原 owner 接管；若清理任务已删除该行，则以同一 ID 和成员
 * 重建。重新占位前锁定成员并检查实时容量；仍有效的原租约已计入容量，可直接换 owner。
 * 其他 owner 已先接管或成员容量已满时两条路径都不会命中。
 */
export type TakeoverBackendMemberLeaseInput = z.input<
  typeof takeoverLeaseInputSchema
>;

/** 仅允许当前 owner 删除租约的输入。 */
export type ReleaseBackendMemberLeaseInput = z.input<
  typeof releaseLeaseInputSchema
>;

/** runtime-service 使用的统一号池仓储端口。 */
export interface BackendPoolRepository {
  acquireLease(
    input: AcquireBackendMemberLeaseInput
  ): Promise<AcquireBackendMemberLeaseResult>;
  renewLease(
    input: RenewBackendMemberLeaseInput
  ): Promise<BackendMemberLease | null>;
  takeoverLease(
    input: TakeoverBackendMemberLeaseInput
  ): Promise<BackendMemberLease | null>;
  releaseLease(input: ReleaseBackendMemberLeaseInput): Promise<boolean>;
}

/** 仅暴露参数化 SQL 执行能力的事务端口。 */
export interface BackendPoolTransaction {
  execute(query: SQL): Promise<unknown>;
}

/** 标准 PostgreSQL 与 Neon 都能适配的最小事务入口。 */
export interface BackendPoolDatabase {
  transaction<T>(
    work: (transaction: BackendPoolTransaction) => Promise<T>
  ): Promise<T>;
}

/** 将数据库租约行映射为仓储端口类型。 */
function parseLeaseRow(value: unknown): BackendMemberLease {
  const row = leaseRowSchema.parse(value);
  return {
    id: row.id,
    memberId: row.member_id,
    ownerToken: row.owner_token,
    apiAdapterMemberId: row.api_adapter_member_id,
    apiAdapterVersionId: row.api_adapter_version_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 校验 RETURNING 确实命中一行，防止事务内静默丢失成员。 */
function assertMutationReturnedId(result: unknown, resource: string): void {
  const rows = z.array(mutationIdRowSchema).parse(extractExecuteRows(result));
  if (rows.length > 0) return;
  throw new Error(`${resource} disappeared during the locked transaction`);
}

/** 构造排除成员的参数化谓词；空集合直接返回 true。 */
function buildExcludedMemberPredicate(
  excludedMemberIds: readonly string[]
): SQL {
  if (excludedMemberIds.length === 0) return sql`true`;
  const parameters = excludedMemberIds.map((id) => sql`${id}`);
  return sql`m.id not in (${sql.join(parameters, sql`, `)})`;
}

/**
 * 创建统一号池 PostgreSQL 仓储。
 *
 * @param database 支持事务的 PostgreSQL/Neon 端口。
 * @returns 不带任何进程内降级路径的仓储实现。
 */
export function createPostgresBackendPoolRepository(
  database: BackendPoolDatabase
): BackendPoolRepository {
  return {
    async acquireLease(rawInput) {
      const input = acquireLeaseInputSchema.parse(rawInput);
      return database.transaction(async (transaction) => {
        const strategyRows = z.array(strategyRowSchema).parse(
          extractExecuteRows(
            await transaction.execute(sql`
                select value
                from system_setting
                where key = ${IMAGE_BACKEND_SCHEDULING_STRATEGY_SETTING_KEY}
                limit 1
              `)
          )
        );
        const strategy = normalizeBackendSchedulingStrategy(
          strategyRows[0]?.value
        );

        // WHY：先清理过期行，随后所有容量聚合只读取当前事务时间点的有效租约。
        await transaction.execute(sql`
          delete from image_backend_member_lease
          where expires_at <= ${input.now}
        `);

        // WHY：稳定 ID 顺序加锁让并发事务以相同次序等待，避免不同策略排序制造死锁。
        const lockedRows = z.array(lockedMemberRowSchema).parse(
          extractExecuteRows(
            await transaction.execute(sql`
                select
                  m.id,
                  m.type,
                  m.name,
                  m.supported_model_ids,
                  m.supported_resolutions_by_model,
                  m.content_safety_enabled,
                  m.is_enabled,
                  m.priority,
                  m.concurrency,
                  m.lease_acquired_count,
                  m.status,
                  m.health_status,
                  m.last_acquired_at,
                  m.last_used_at,
                  m.cooldown_until,
                  api_version.member_id_snapshot as api_adapter_member_id,
                  api_version.id as api_adapter_version_id
                from image_backend_member as m
                inner join image_backend_member_group as membership
                  on membership.member_id = m.id
                left join image_backend_member_api_config as api_config
                  on api_config.member_id = m.id
                left join image_backend_member_api_adapter_version as api_version
                  on api_version.id = coalesce(
                    ${input.requiredApiAdapterVersionId ?? null}::text,
                    api_config.current_adapter_version_id
                  )
                  and api_version.member_id_snapshot = m.id
                  and api_version.credential_scope = api_config.credential_scope
                where membership.group_id = ${input.groupId}
                  and m.is_enabled = true
                  and (m.cooldown_until is null or m.cooldown_until <= ${input.now})
                  and m.status not in (${sql.join(
                    TERMINAL_BACKEND_MEMBER_STATUSES.map(
                      (status) => sql`${status}`
                    ),
                    sql`, `
                  )})
                  and exists (
                    select 1
                    from json_array_elements_text(m.supported_model_ids)
                      as supported_model(model_id)
                    where lower(trim(supported_model.model_id)) =
                      lower(${input.requestedModel})
                  )
                  and (
                    ${input.requestedResolution ?? null}::text is null
                    or (m.supported_resolutions_by_model -> lower(trim(${input.requestedModel}))) is null
                    or exists (
                      select 1
                      from json_array_elements_text(
                        m.supported_resolutions_by_model -> lower(trim(${input.requestedModel}))
                      ) as supported_resolution(resolution)
                      where lower(trim(supported_resolution.resolution)) = lower(trim(${input.requestedResolution ?? ""}))
                    )
                  )
                  and (
                    ${input.requiresContentSafety} = false
                    or m.content_safety_enabled = true
                  )
                  and (
                    ${input.requiredVideoInputCapabilities.referenceVideos} = false
                    or (
                      m.type = 'api'
                      and coalesce(
                        (api_version.configuration->'videoInputCapabilitiesByModel'->lower(trim(${input.requestedModel}))->>'referenceVideos')::boolean,
                        (api_version.configuration->'videoInputCapabilities'->>'referenceVideos')::boolean,
                        false
                      ) = true
                    )
                  )
                  and (
                    ${input.requiredVideoInputCapabilities.referenceAudios} = false
                    or (
                      m.type = 'api'
                      and coalesce(
                        (api_version.configuration->'videoInputCapabilitiesByModel'->lower(trim(${input.requestedModel}))->>'referenceAudios')::boolean,
                        (api_version.configuration->'videoInputCapabilities'->>'referenceAudios')::boolean,
                        false
                      ) = true
                    )
                  )
                  and ${buildExcludedMemberPredicate(input.excludedMemberIds)}
                  and (${input.requiredMemberId ?? null}::text is null or m.id = ${
                    input.requiredMemberId ?? null
                  })
                  and (${input.requiredMemberType ?? null}::text is null or m.type = ${
                    input.requiredMemberType ?? null
                  })
                  and (${input.requiredApiAdapterMemberId ?? null}::text is null or m.id = ${
                    input.requiredApiAdapterMemberId ?? null
                  })
                  and m.type = 'api'
                  and api_config.api_key is not null
                  and api_version.id is not null
                order by m.id asc
                for update of m
              `)
          )
        );

        if (lockedRows.length === 0) {
          return {
            status: "no_candidate" as const,
            strategy,
            eligibleCandidateCount: 0 as const,
          };
        }

        const memberIds = lockedRows.map((row) => row.id);
        const activeLeaseRows = z.array(activeLeaseCountRowSchema).parse(
          extractExecuteRows(
            await transaction.execute(sql`
                select
                  member_id,
                  count(*)::integer as inflight_count
                from image_backend_member_lease
                where expires_at > ${input.now}
                  and member_id in (${sql.join(
                    memberIds.map((memberId) => sql`${memberId}`),
                    sql`, `
                  )})
                group by member_id
              `)
          )
        );
        const inflightByMemberId = new Map(
          activeLeaseRows.map((row) => [row.member_id, row.inflight_count])
        );

        const candidates: LockedBackendMemberCandidate[] = lockedRows
          .map((row) => ({
            id: row.id,
            type: row.type,
            name: row.name,
            groupIds: [input.groupId],
            supportedModelIds: row.supported_model_ids,
            supportedResolutionsByModel: row.supported_resolutions_by_model,
            contentSafetyEnabled: row.content_safety_enabled,
            isEnabled: row.is_enabled,
            cooldownUntil: row.cooldown_until,
            hasTerminalError: row.status === "error",
            priority: row.priority,
            concurrency: row.concurrency,
            leaseAcquiredCount: row.lease_acquired_count,
            status: row.status,
            healthStatus: row.health_status,
            isHealthy:
              row.status === "active" && row.health_status === "healthy",
            inflightCount: inflightByMemberId.get(row.id) ?? 0,
            lastAcquiredAt: row.last_acquired_at,
            lastUsedAt: row.last_used_at,
          }))
          .filter(
            (candidate) => candidate.inflightCount < candidate.concurrency
          );
        const selected = sortBackendSchedulingCandidates(
          candidates,
          strategy
        )[0];
        if (!selected) {
          return {
            status: "capacity_rejected" as const,
            strategy,
            eligibleCandidateCount: lockedRows.length,
          };
        }
        const selectedRow = lockedRows.find((row) => row.id === selected.id);
        if (!selectedRow) {
          throw new Error(
            "selected backend member disappeared before lease insert"
          );
        }

        const leaseResult = await transaction.execute(sql`
          insert into image_backend_member_lease (
            id,
            member_id,
            owner_token,
            api_adapter_member_id,
            api_adapter_version_id,
            expires_at,
            created_at,
            updated_at
          ) values (
            ${input.leaseId},
            ${selected.id},
            ${input.ownerToken},
            ${selectedRow.api_adapter_member_id},
            ${selectedRow.api_adapter_version_id},
            ${input.expiresAt},
            ${input.now},
            ${input.now}
          )
          returning id, member_id, owner_token,
            api_adapter_member_id, api_adapter_version_id,
            expires_at, created_at, updated_at
        `);
        const leaseRawRow = extractExecuteRows(leaseResult)[0];
        if (!leaseRawRow) {
          throw new Error("backend member lease was not created");
        }
        const lease = parseLeaseRow(leaseRawRow);

        const memberUpdateResult = await transaction.execute(sql`
          update image_backend_member
          set lease_acquired_count = lease_acquired_count + 1,
              last_acquired_at = ${input.now},
              updated_at = ${input.now}
          where id = ${selected.id}
          returning id
        `);
        assertMutationReturnedId(memberUpdateResult, "backend member");

        return {
          status: "acquired" as const,
          acquisition: {
            strategy,
            member: {
              ...selected,
              inflightCount: selected.inflightCount + 1,
              leaseAcquiredCount: selected.leaseAcquiredCount + 1,
              lastAcquiredAt: input.now,
            },
            lease,
            eligibleCandidateCount: candidates.length,
          },
        };
      });
    },

    async renewLease(rawInput) {
      const input = renewLeaseInputSchema.parse(rawInput);
      return database.transaction(async (transaction) => {
        const result = await transaction.execute(sql`
          update image_backend_member_lease
          set expires_at = ${input.expiresAt},
              updated_at = ${input.now}
          where id = ${input.leaseId}
            and owner_token = ${input.ownerToken}
            and expires_at > ${input.now}
          returning id, member_id, owner_token,
            api_adapter_member_id, api_adapter_version_id,
            expires_at, created_at, updated_at
        `);
        const row = extractExecuteRows(result)[0];
        return row ? parseLeaseRow(row) : null;
      });
    },

    async takeoverLease(rawInput) {
      const input = takeoverLeaseInputSchema.parse(rawInput);
      return database.transaction(async (transaction) => {
        const result = await transaction.execute(sql`
          with locked_member as materialized (
            select id, concurrency
            from image_backend_member
            where id = ${input.memberId}
            for update
          ), current_lease as materialized (
            select id, expires_at
            from image_backend_member_lease
            where id = ${input.leaseId}
              and member_id = ${input.memberId}
              and owner_token = ${input.currentOwnerToken}
            for update
          ), active_capacity as (
            select count(*)::integer as inflight_count
            from image_backend_member_lease
            where member_id = ${input.memberId}
              and expires_at > ${input.now}
          ), eligible as (
            select locked_member.id
            from locked_member, active_capacity
            where exists (
                select 1
                from current_lease
                where expires_at > ${input.now}
              )
              or active_capacity.inflight_count < locked_member.concurrency
          ), recovered as (
            update image_backend_member_lease
            set owner_token = ${input.nextOwnerToken},
                expires_at = ${input.expiresAt},
                updated_at = ${input.now}
            where id = ${input.leaseId}
              and member_id = ${input.memberId}
              and owner_token = ${input.currentOwnerToken}
              and exists (select 1 from eligible)
            returning id, member_id, owner_token,
              api_adapter_member_id, api_adapter_version_id,
              expires_at, created_at, updated_at
          ), recreated as (
            insert into image_backend_member_lease (
              id,
              member_id,
              owner_token,
              api_adapter_member_id,
              api_adapter_version_id,
              expires_at,
              created_at,
              updated_at
            )
            select
              ${input.leaseId},
              ${input.memberId},
              ${input.nextOwnerToken},
              ${input.apiAdapterMemberId ?? null},
              ${input.apiAdapterVersionId ?? null},
              ${input.expiresAt},
              ${input.now},
              ${input.now}
            where exists (select 1 from eligible)
              and not exists (select 1 from current_lease)
              and not exists (select 1 from recovered)
            on conflict do nothing
            returning id, member_id, owner_token,
              api_adapter_member_id, api_adapter_version_id,
              expires_at, created_at, updated_at
          )
          select * from recovered
          union all
          select * from recreated
        `);
        const row = extractExecuteRows(result)[0];
        return row ? parseLeaseRow(row) : null;
      });
    },

    async releaseLease(rawInput) {
      const input = releaseLeaseInputSchema.parse(rawInput);
      return database.transaction(async (transaction) => {
        const result = await transaction.execute(sql`
          delete from image_backend_member_lease
          where id = ${input.leaseId}
            and owner_token = ${input.ownerToken}
          returning id
        `);
        const rows = z
          .array(mutationIdRowSchema)
          .parse(extractExecuteRows(result));
        return rows.length > 0;
      });
    },
  };
}

/** 默认生产仓储；数据库不可用或事务失败时错误直接上抛。 */
export const defaultBackendPoolRepository: BackendPoolRepository =
  createPostgresBackendPoolRepository({
    async transaction(work) {
      const { db } = await import("@repo/database");
      return db.transaction(async (transaction) =>
        work({ execute: (query) => transaction.execute(query) })
      );
    },
  });
