/**
 * 统一媒体后端分组服务。
 *
 * 职责：校验分组层级，在 PostgreSQL 事务内保存唯一默认组，提供管理摘要与用户
 * 可选项，并拒绝删除仍参与成员关系或层级关系的分组。所有 metadata 均通过共享
 * 契约收窄，不保留套餐门槛或 Web/Responses 车道字段。
 */
import {
  type BackendGroupInput,
  type BackendGroupSummary,
  backendGroupInputSchema,
  createBackendGroupMetadata,
  fromBackendGroupContentSafety,
  parseBackendGroupMetadata,
  toBackendGroupContentSafety,
} from "@repo/shared/image-backend/group-contract";
import { asc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

/** 分组服务可稳定映射到 UOL 的错误码。 */
export type BackendGroupServiceErrorCode =
  | "not_found"
  | "conflict"
  | "validation_error";

/** 分组服务错误；消息可安全返回给管理后台。 */
export class BackendGroupServiceError extends Error {
  /** 创建带稳定错误码的分组领域错误。 */
  constructor(
    readonly code: BackendGroupServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BackendGroupServiceError";
  }
}

/** 已补齐稳定 ID 的统一分组保存输入。 */
export type PersistedBackendGroupInput = BackendGroupInput & {
  id: string;
  isCreate: boolean;
};

/** 用于层级校验的最小分组投影。 */
export interface BackendGroupTopologyNode {
  id: string;
  childGroupIds: string[];
}

/** 原子保存仓储返回的稳定结果。 */
export type SaveBackendGroupRepositoryResult =
  | { status: "saved"; id: string }
  | { status: "not_found" }
  | { status: "already_exists" }
  | { status: "unknown_child" }
  | { status: "self_reference" }
  | { status: "cycle" };

/** 安全删除仓储返回的稳定结果。 */
export type DeleteBackendGroupRepositoryResult =
  | "deleted"
  | "not_found"
  | "default_group"
  | "in_use";

/** 分组服务依赖的事务仓储端口。 */
export interface BackendGroupRepository {
  saveGroup(
    input: PersistedBackendGroupInput,
    now: Date
  ): Promise<SaveBackendGroupRepositoryResult>;
  listGroups(): Promise<BackendGroupSummary[]>;
  listGroupOptions(): Promise<Array<{ id: string; name: string }>>;
  deleteGroup(groupId: string): Promise<DeleteBackendGroupRepositoryResult>;
}

/** 分组服务的可注入依赖。 */
export interface BackendGroupServiceDependencies {
  repository: BackendGroupRepository;
  createId?: () => string;
  now?: () => Date;
}

/** 统一分组服务公开接口。 */
export interface BackendGroupService {
  saveGroup(input: unknown): Promise<{ id: string }>;
  listGroups(): Promise<BackendGroupSummary[]>;
  listGroupOptions(): Promise<Array<{ id: string; name: string }>>;
  deleteGroup(groupId: string): Promise<{ success: true }>;
}

/**
 * 校验保存后的分组有向图。
 *
 * @param input 本次保存的完整分组输入。
 * @param groups 当前事务内锁定的分组拓扑。
 * @returns 可持久化时返回 null，否则返回稳定失败状态。
 */
export function validateBackendGroupTopology(
  input: Pick<PersistedBackendGroupInput, "id" | "childGroupIds">,
  groups: readonly BackendGroupTopologyNode[]
): "unknown_child" | "self_reference" | "cycle" | null {
  if (input.childGroupIds.includes(input.id)) return "self_reference";

  const graph = new Map(
    groups.map((group) => [group.id, [...group.childGroupIds]])
  );
  for (const childGroupId of input.childGroupIds) {
    if (!graph.has(childGroupId)) return "unknown_child";
  }
  graph.set(input.id, [...input.childGroupIds]);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  /** 深度优先检查任意层级环；未知旧引用不扩张为合法节点。 */
  function hasCycle(groupId: string): boolean {
    if (visiting.has(groupId)) return true;
    if (visited.has(groupId)) return false;
    visiting.add(groupId);
    for (const childGroupId of graph.get(groupId) ?? []) {
      if (graph.has(childGroupId) && hasCycle(childGroupId)) return true;
    }
    visiting.delete(groupId);
    visited.add(groupId);
    return false;
  }

  return [...graph.keys()].some(hasCycle) ? "cycle" : null;
}

/** 将仓储保存结果映射为稳定领域错误。 */
function assertGroupSaved(
  result: SaveBackendGroupRepositoryResult
): asserts result is { status: "saved"; id: string } {
  switch (result.status) {
    case "saved":
      return;
    case "not_found":
      throw new BackendGroupServiceError("not_found", "媒体后端分组不存在");
    case "already_exists":
      throw new BackendGroupServiceError("conflict", "媒体后端分组 ID 已存在");
    case "unknown_child":
      throw new BackendGroupServiceError(
        "validation_error",
        "选择的子分组不存在"
      );
    case "self_reference":
      throw new BackendGroupServiceError(
        "validation_error",
        "媒体后端分组不能包含自身"
      );
    case "cycle":
      throw new BackendGroupServiceError(
        "validation_error",
        "媒体后端分组层级不能形成循环"
      );
  }
}

/**
 * 创建统一分组领域服务。
 *
 * @param dependencies 仓储、ID 与时钟依赖。
 * @returns 无进程缓存且写入委托原子仓储的服务。
 */
export function createBackendGroupService(
  dependencies: BackendGroupServiceDependencies
): BackendGroupService {
  const createId = dependencies.createId ?? nanoid;
  const now = dependencies.now ?? (() => new Date());

  return {
    async saveGroup(rawInput) {
      const input = backendGroupInputSchema.parse(rawInput);
      const result = await dependencies.repository.saveGroup(
        {
          ...input,
          id: input.id ?? createId(),
          isCreate: input.id === undefined,
        },
        now()
      );
      assertGroupSaved(result);
      return { id: result.id };
    },

    async listGroups() {
      return dependencies.repository.listGroups();
    },

    async listGroupOptions() {
      return dependencies.repository.listGroupOptions();
    },

    async deleteGroup(groupId) {
      const id = z.string().trim().min(1).max(128).parse(groupId);
      const result = await dependencies.repository.deleteGroup(id);
      if (result === "not_found") {
        throw new BackendGroupServiceError("not_found", "媒体后端分组不存在");
      }
      if (result === "default_group") {
        throw new BackendGroupServiceError(
          "conflict",
          "默认媒体后端分组不能删除"
        );
      }
      if (result === "in_use") {
        throw new BackendGroupServiceError(
          "conflict",
          "分组仍有关联成员或层级关系，不能删除"
        );
      }
      return { success: true };
    },
  };
}

/** 默认分组写入使用的数据库事务互斥锁。 */
async function lockBackendGroups(transaction: {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext('fluxmedia:image_backend_group'))`
  );
}

/** 把数据库分组行映射为可完整回填的管理摘要。 */
function mapBackendGroupRow(row: {
  id: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  isUserSelectable: boolean;
  contentSafetyEnabled: boolean | null;
  priority: number;
  metadata: Record<string, unknown> | null;
}): BackendGroupSummary {
  const metadata = parseBackendGroupMetadata(row.metadata);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isEnabled: row.isEnabled,
    isDefault: row.isDefault,
    isUserSelectable: row.isUserSelectable,
    contentSafety: fromBackendGroupContentSafety(row.contentSafetyEnabled),
    imageCreditOverrides: metadata.imageCreditOverrides,
    videoCreditOverrides: metadata.videoCreditOverrides,
    childGroupIds: metadata.childGroupIds,
    priority: row.priority,
  };
}

/** 默认 Drizzle 分组仓储；所有层级与默认组不变量在同一事务中检查并写入。 */
export const defaultBackendGroupRepository: BackendGroupRepository = {
  async saveGroup(input, now) {
    const { db, imageBackendGroup } = await import("@repo/database");
    return db.transaction(async (transaction) => {
      await lockBackendGroups(transaction);
      const groups = await transaction
        .select({
          id: imageBackendGroup.id,
          metadata: imageBackendGroup.metadata,
        })
        .from(imageBackendGroup)
        .orderBy(asc(imageBackendGroup.createdAt));
      const existing = groups.find((group) => group.id === input.id);
      if (input.isCreate && existing) {
        return { status: "already_exists" } as const;
      }
      if (!input.isCreate && !existing) {
        return { status: "not_found" } as const;
      }

      const topologyError = validateBackendGroupTopology(
        input,
        groups.map((group) => ({
          id: group.id,
          childGroupIds: parseBackendGroupMetadata(group.metadata)
            .childGroupIds,
        }))
      );
      if (topologyError) return { status: topologyError } as const;

      if (input.isDefault) {
        await transaction
          .update(imageBackendGroup)
          .set({ isDefault: false, updatedAt: now })
          .where(eq(imageBackendGroup.isDefault, true));
      }

      const values = {
        name: input.name,
        description: input.description || null,
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
        isUserSelectable: input.isUserSelectable,
        contentSafetyEnabled: toBackendGroupContentSafety(input.contentSafety),
        priority: input.priority,
        metadata: createBackendGroupMetadata(input),
        updatedAt: now,
      };
      await transaction
        .insert(imageBackendGroup)
        .values({
          id: input.id,
          ...values,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: imageBackendGroup.id,
          set: values,
        });
      return { status: "saved", id: input.id } as const;
    });
  },

  async listGroups() {
    const { db, imageBackendGroup } = await import("@repo/database");
    const rows = await db
      .select()
      .from(imageBackendGroup)
      .orderBy(asc(imageBackendGroup.createdAt), asc(imageBackendGroup.id));
    return rows.map(mapBackendGroupRow);
  },

  async listGroupOptions() {
    const { db, imageBackendGroup } = await import("@repo/database");
    return db
      .select({ id: imageBackendGroup.id, name: imageBackendGroup.name })
      .from(imageBackendGroup)
      .where(
        sql`${imageBackendGroup.isEnabled} = true and ${imageBackendGroup.isUserSelectable} = true`
      )
      .orderBy(asc(imageBackendGroup.createdAt), asc(imageBackendGroup.id));
  },

  async deleteGroup(groupId) {
    const { db, imageBackendGroup, imageBackendMemberGroup } = await import(
      "@repo/database"
    );
    return db.transaction(async (transaction) => {
      await lockBackendGroups(transaction);
      const groups = await transaction
        .select({
          id: imageBackendGroup.id,
          isDefault: imageBackendGroup.isDefault,
          metadata: imageBackendGroup.metadata,
        })
        .from(imageBackendGroup)
        .orderBy(asc(imageBackendGroup.createdAt));
      const current = groups.find((group) => group.id === groupId);
      if (!current) return "not_found";
      if (current.isDefault) return "default_group";

      const [membership] = await transaction
        .select({ id: imageBackendMemberGroup.id })
        .from(imageBackendMemberGroup)
        .where(eq(imageBackendMemberGroup.groupId, groupId))
        .limit(1);
      const hasHierarchyRelation = groups.some((group) => {
        const childGroupIds = parseBackendGroupMetadata(
          group.metadata
        ).childGroupIds;
        return (
          (group.id === groupId && childGroupIds.length > 0) ||
          childGroupIds.includes(groupId)
        );
      });
      if (membership || hasHierarchyRelation) return "in_use";

      const deleted = await transaction
        .delete(imageBackendGroup)
        .where(eq(imageBackendGroup.id, groupId))
        .returning({ id: imageBackendGroup.id });
      return deleted.length > 0 ? "deleted" : "not_found";
    });
  },
};

/** 默认生产分组服务。 */
export const backendGroupService = createBackendGroupService({
  repository: defaultBackendGroupRepository,
});
