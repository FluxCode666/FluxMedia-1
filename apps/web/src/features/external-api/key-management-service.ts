/**
 * API 密钥管理应用服务。
 *
 * 职责：集中处理密钥生成/散列、分组资格、额度归一、所有权条件和生命周期
 * 竞态；UOL binding 只注入可信 userId。默认依赖延迟加载数据库，纯工厂可 DB-free 单测。
 * 使用方：apps/web/src/server/uol-bindings.ts 与 API 密钥管理 Server Actions。
 * 关键依赖：Drizzle 仓储、后端分组选项、quota-math。
 */
import { randomBytes } from "node:crypto";

import type { externalApiKey as externalApiKeyTable } from "@repo/database/schema";
import type { ExternalApiKeySummary } from "@repo/shared/uol/operations";
import { nanoid } from "nanoid";

import { hashApiKey } from "./auth-token";
import { normalizeExternalApiKeyCreditLimit } from "./quota-math";

const API_KEY_PREFIX = "sk-";
const DEFAULT_KEY_NAME = "默认 API 密钥";

export type ExternalApiKeyManagementErrorCode =
  | "not_found"
  | "state_conflict"
  | "validation_error";

/** API 密钥管理中可安全映射到 UOL 的预期领域错误。 */
export class ExternalApiKeyManagementError extends Error {
  readonly code: ExternalApiKeyManagementErrorCode;

  /**
   * 创建带稳定错误码的 API 密钥领域错误。
   *
   * @param code 可供传输层稳定映射的领域错误码。
   * @param message 面向调用方的可定位错误说明。
   * @returns 新的错误实例；构造过程不产生外部副作用。
   * @throws 不主动抛错；边界是仅接收已声明的领域错误码。
   */
  constructor(code: ExternalApiKeyManagementErrorCode, message: string) {
    super(message);
    this.name = "ExternalApiKeyManagementError";
    this.code = code;
  }
}

/** 仓储返回的可信 API 密钥行；不包含明文和哈希。 */
export type ExternalApiKeyRecord = {
  id: string;
  name: string;
  keyPrefix: string;
  lastFour: string;
  generationGroupId: string | null;
  creditLimit: number | null;
  creditsUsed: number;
  lastUsedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** 服务内部使用的后端分组最小视图。 */
export type ExternalApiKeyGroupRecord = {
  id: string;
  name: string;
  isEnabled: boolean;
};

export type { ExternalApiKeySummary } from "@repo/shared/uol/operations";

/** 创建仓储行时唯一允许写入的字段。 */
export type ExternalApiKeyInsert = {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  lastFour: string;
  generationGroupId: string | null;
  creditLimit: number | null;
  createdAt: Date;
  updatedAt: Date;
};

/** 数据库仓储边界；所有生命周期写入都必须带 userId 和状态条件。 */
export interface ExternalApiKeyRepository {
  listByUser(userId: string): Promise<
    Array<{
      key: ExternalApiKeyRecord;
      currentGroup: ExternalApiKeyGroupRecord | null;
    }>
  >;
  insert(values: ExternalApiKeyInsert): Promise<ExternalApiKeyRecord | null>;
  revokeActive(
    userId: string,
    keyId: string,
    updatedAt: Date
  ): Promise<ExternalApiKeyRecord | null>;
  deleteRevoked(userId: string, keyId: string): Promise<{ id: string } | null>;
  updateActiveGroup(
    userId: string,
    keyId: string,
    generationGroupId: string | null,
    updatedAt: Date
  ): Promise<ExternalApiKeyRecord | null>;
  updateActiveQuota(
    userId: string,
    keyId: string,
    creditLimit: number | null,
    updatedAt: Date
  ): Promise<ExternalApiKeyRecord | null>;
  findState(
    userId: string,
    keyId: string
  ): Promise<{ isActive: boolean } | null>;
}

type ServiceDependencies = {
  repository: ExternalApiKeyRepository;
  listSelectableGroups(): Promise<ExternalApiKeyGroupRecord[]>;
  getGroupById(groupId: string): Promise<ExternalApiKeyGroupRecord | null>;
  createId(): string;
  createSecret(): string;
  hashSecret(secret: string): string;
  now(): Date;
};

export type CreateExternalApiKeyInput = {
  name?: string;
  generationGroupId?: string | null;
  creditLimit?: number | null;
};

/**
 * 将仓储行和分组资格裁剪成可公开返回的密钥摘要。
 *
 * @param key 仓储返回的可信密钥行，不含明文或哈希。
 * @param currentGroup 密钥当前引用的分组；分组不存在时为 null。
 * @param selectableGroupIds 当前允许选择的分组 ID 集合。
 * @returns 不包含 userId、哈希或明文，并标注分组可选性的摘要。
 * @throws 不主动抛错；不会修改输入记录或集合。
 */
function toKeySummary(
  key: ExternalApiKeyRecord,
  currentGroup: ExternalApiKeyGroupRecord | null,
  selectableGroupIds: ReadonlySet<string>
): ExternalApiKeySummary {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    lastFour: key.lastFour,
    generationGroupId: key.generationGroupId,
    creditLimit: key.creditLimit,
    creditsUsed: key.creditsUsed,
    lastUsedAt: key.lastUsedAt,
    isActive: key.isActive,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
    currentGroup: currentGroup
      ? {
          id: currentGroup.id,
          name: currentGroup.name,
          enabled: currentGroup.isEnabled,
          selectable: selectableGroupIds.has(currentGroup.id),
        }
      : null,
  };
}

/**
 * 生成带固定前缀的高熵 API 密钥明文。
 *
 * @returns `sk-` 前缀与 32 字节随机内容组成的密钥。
 * @throws 系统随机源不可用时透传 `randomBytes` 的错误。
 * @remarks 副作用是读取系统随机源；明文仅应由 create 流程返回一次。
 */
function createApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * 创建可注入依赖的 API 密钥应用服务。
 *
 * 所有 mutation 先执行单条带所有权/状态条件的写入；0 行后才读取当前状态区分
 * not_found 与 state_conflict，避免先查后写导致假成功。
 *
 * @param dependencies 仓储、分组查询及密钥生成等可注入依赖。
 * @returns 提供列出、创建、撤销、删除和更新密钥能力的应用服务。
 * @throws 工厂本身不访问外部资源；各方法会透传依赖错误并抛出领域错误。
 */
export function createExternalApiKeyManagementService(
  dependencies: ServiceDependencies
) {
  /**
   * 读取当前真实可编辑的分组。
   *
   * @returns 可选分组列表。
   * @throws 分组提供方失败时透传错误。
   * @remarks 副作用仅为读取可选分组。
   */
  async function loadEditableGroups(): Promise<ExternalApiKeyGroupRecord[]> {
    return dependencies.listSelectableGroups();
  }

  /**
   * 将分组输入归一为默认分组或当前确实可选的分组 ID。
   *
   * @param groupId 用户提交的分组 ID；空值或 `default` 表示默认分组。
   * @returns 归一后的分组 ID，以及本次校验使用的可编辑分组列表。
   * @throws 非默认分组不在可选列表时抛出 `validation_error`；依赖失败时透传。
   * @remarks 副作用仅为读取可选分组。
   */
  async function normalizeGroupId(groupId: string | null | undefined): Promise<{
    groupId: string | null;
    editableGroups: ExternalApiKeyGroupRecord[];
  }> {
    const editableGroups = await loadEditableGroups();
    if (!groupId || groupId === "default") {
      return { groupId: null, editableGroups };
    }
    if (!editableGroups.some((group) => group.id === groupId)) {
      throw new ExternalApiKeyManagementError(
        "validation_error",
        "所选生图分组当前不可用"
      );
    }
    return { groupId, editableGroups };
  }

  /**
   * 用当前分组状态和可选资格装饰 mutation 返回的数据库行。
   *
   * @param key 数据库 mutation 实际返回的安全密钥行。
   * @param editableGroups 可复用的可编辑分组；缺省时重新读取。
   * @returns 带当前分组显示信息和可选性标记的公开摘要。
   * @throws 分组查询失败时透传错误。
   * @remarks 不执行写入；可能读取当前分组。
   */
  async function decorateMutationRow(
    key: ExternalApiKeyRecord,
    editableGroups?: ExternalApiKeyGroupRecord[]
  ): Promise<ExternalApiKeySummary> {
    const groups = editableGroups ?? (await loadEditableGroups());
    const currentGroup = key.generationGroupId
      ? await dependencies.getGroupById(key.generationGroupId)
      : null;
    return toKeySummary(
      key,
      currentGroup,
      new Set(groups.map((group) => group.id))
    );
  }

  /**
   * 在条件 mutation 返回 0 行后判定准确的生命周期错误。
   *
   * @param userId 已由调用边界鉴权的用户 ID，用于限定所有权范围。
   * @param keyId 未成功 mutation 的密钥 ID。
   * @param conflictMessage 资源存在但状态不允许操作时的错误说明。
   * @returns 永不返回。
   * @throws 密钥不存在时抛出 `not_found`，否则抛出 `state_conflict`；查询失败时透传。
   * @remarks 副作用仅为在用户范围内读取密钥状态。
   */
  async function throwMutationMiss(
    userId: string,
    keyId: string,
    conflictMessage: string
  ): Promise<never> {
    const state = await dependencies.repository.findState(userId, keyId);
    if (!state) {
      throw new ExternalApiKeyManagementError("not_found", "API 密钥不存在");
    }
    throw new ExternalApiKeyManagementError("state_conflict", conflictMessage);
  }

  return {
    /**
     * 列出用户全部密钥，并分开返回当前分组与可编辑候选。
     *
     * @param userId 已由调用边界鉴权的用户 ID。
     * @returns 安全密钥摘要和当前可编辑分组。
     * @throws 分组或仓储读取失败时透传错误。
     * @remarks 只执行读取；返回值不包含密钥明文、哈希或 userId。
     */
    async listKeys(userId: string) {
      const [rows, editableGroups] = await Promise.all([
        dependencies.repository.listByUser(userId),
        loadEditableGroups(),
      ]);
      const selectableGroupIds = new Set(
        editableGroups.map((group) => group.id)
      );
      return {
        keys: rows.map(({ key, currentGroup }) =>
          toKeySummary(key, currentGroup, selectableGroupIds)
        ),
        editableGroups: editableGroups.map((group) => ({
          id: group.id,
          name: group.name,
          enabled: group.isEnabled,
          selectable: true,
        })),
      };
    },

    /**
     * 为用户创建 API 密钥，并仅在本次调用中返回一次明文。
     *
     * @param userId 已由调用边界鉴权的用户 ID。
     * @param input 名称、分组和额度上限；空名称使用默认名称。
     * @returns 一次性密钥明文及不含明文和哈希的持久化摘要。
     * @throws 分组不可选或额度非法时抛错；仓储及依赖失败时透传。
     * @remarks 会生成随机密钥并插入数据库；摘要装饰失败时插入仍可能已成功。
     */
    async createKey(userId: string, input: CreateExternalApiKeyInput) {
      const { groupId, editableGroups } = await normalizeGroupId(
        input.generationGroupId
      );
      const apiKey = dependencies.createSecret();
      const timestamp = dependencies.now();
      const key = await dependencies.repository.insert({
        id: dependencies.createId(),
        userId,
        name: input.name?.trim() || DEFAULT_KEY_NAME,
        keyPrefix: apiKey.slice(0, 7),
        keyHash: dependencies.hashSecret(apiKey),
        lastFour: apiKey.slice(-4),
        generationGroupId: groupId,
        creditLimit: normalizeExternalApiKeyCreditLimit(input.creditLimit),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (!key) {
        throw new Error("API key insert did not return a row");
      }
      return {
        apiKey,
        key: await decorateMutationRow(key, editableGroups),
      };
    },

    /**
     * 原子撤销用户本人当前启用的密钥。
     *
     * @param userId 已由调用边界鉴权的用户 ID。
     * @param keyId 待撤销的密钥 ID。
     * @returns 已撤销密钥的公开摘要。
     * @throws 密钥不存在时抛出 `not_found`，已撤销时抛出
     * `state_conflict`；仓储及装饰查询失败时透传。
     * @remarks 以所有权和启用态为条件更新数据库；装饰失败时撤销仍可能已成功。
     */
    async revokeKey(
      userId: string,
      keyId: string
    ): Promise<ExternalApiKeySummary> {
      const updated = await dependencies.repository.revokeActive(
        userId,
        keyId,
        dependencies.now()
      );
      if (!updated) {
        return throwMutationMiss(userId, keyId, "API 密钥已被撤销");
      }
      return decorateMutationRow(updated);
    },

    /**
     * 删除用户本人已撤销的密钥。
     *
     * @param userId 已由调用边界鉴权的用户 ID。
     * @param keyId 待删除的密钥 ID。
     * @returns 被删除记录的 ID。
     * @throws 密钥不存在时抛出 `not_found`，仍启用或竞态变化时抛出
     * `state_conflict`；仓储失败时透传。
     * @remarks 以所有权和撤销态为条件永久删除数据库记录。
     */
    async deleteKey(userId: string, keyId: string) {
      const deleted = await dependencies.repository.deleteRevoked(
        userId,
        keyId
      );
      if (!deleted) {
        return throwMutationMiss(userId, keyId, "请先撤销 API 密钥再删除");
      }
      return deleted;
    },

    /**
     * 更新用户本人启用密钥的后端分组。
     *
     * @param userId 已由调用边界鉴权的用户 ID。
     * @param keyId 待更新的密钥 ID。
     * @param generationGroupId 新分组 ID；null 表示恢复默认分组。
     * @returns 更新后的公开密钥摘要。
     * @throws 分组不可选、密钥不存在或已撤销时抛出领域错误；
     * 仓储及依赖失败时透传。
     * @remarks 仅在所有权和启用态同时满足时更新；装饰失败时更新仍可能已成功。
     */
    async updateKeyGroup(
      userId: string,
      keyId: string,
      generationGroupId: string | null
    ): Promise<ExternalApiKeySummary> {
      const { groupId, editableGroups } =
        await normalizeGroupId(generationGroupId);
      const updated = await dependencies.repository.updateActiveGroup(
        userId,
        keyId,
        groupId,
        dependencies.now()
      );
      if (!updated) {
        return throwMutationMiss(
          userId,
          keyId,
          "已撤销的 API 密钥不能修改分组"
        );
      }
      return decorateMutationRow(updated, editableGroups);
    },

    /**
     * 更新用户本人启用密钥的积分额度上限。
     *
     * @param userId 已由调用边界鉴权的用户 ID。
     * @param keyId 待更新的密钥 ID。
     * @param creditLimit 新额度；null 表示不限额，有限非负数归一到两位小数。
     * @returns 更新后的公开密钥摘要。
     * @throws 额度非法、密钥不存在或已撤销时抛错；仓储及依赖
     * 失败时透传。
     * @remarks 仅在所有权和启用态同时满足时更新；装饰失败时更新仍可能已成功。
     */
    async updateKeyQuota(
      userId: string,
      keyId: string,
      creditLimit: number | null
    ): Promise<ExternalApiKeySummary> {
      const normalizedLimit = normalizeExternalApiKeyCreditLimit(creditLimit);
      const updated = await dependencies.repository.updateActiveQuota(
        userId,
        keyId,
        normalizedLimit,
        dependencies.now()
      );
      if (!updated) {
        return throwMutationMiss(
          userId,
          keyId,
          "已撤销的 API 密钥不能修改额度"
        );
      }
      return decorateMutationRow(updated);
    },
  };
}

/**
 * 构造数据库查询使用的安全密钥字段投影。
 *
 * @param externalApiKey Drizzle 的 API 密钥表定义。
 * @returns 仅包含 `ExternalApiKeyRecord` 允许进入服务层的字段映射。
 * @throws 不主动抛错；不执行查询或修改表定义。
 * @remarks 排除 userId、密钥哈希和废弃治理列，避免意外进入返回值。
 */
function selectExternalApiKeyFields(
  externalApiKey: typeof externalApiKeyTable
) {
  return {
    id: externalApiKey.id,
    name: externalApiKey.name,
    keyPrefix: externalApiKey.keyPrefix,
    lastFour: externalApiKey.lastFour,
    generationGroupId: externalApiKey.generationGroupId,
    creditLimit: externalApiKey.creditLimit,
    creditsUsed: externalApiKey.creditsUsed,
    lastUsedAt: externalApiKey.lastUsedAt,
    isActive: externalApiKey.isActive,
    createdAt: externalApiKey.createdAt,
    updatedAt: externalApiKey.updatedAt,
  };
}

/**
 * 创建数据库、schema 与 Drizzle 运算符的延迟加载任务。
 *
 * @returns 三个数据库模块并行加载后的 Promise。
 * @throws 任一动态导入失败时拒绝 Promise。
 * @remarks 会启动模块加载，但不会在本文件 import 阶段连接数据库。
 */
function createDatabaseModulesPromise() {
  return Promise.all([
    import("@repo/database"),
    import("@repo/database/schema"),
    import("drizzle-orm"),
  ]);
}

type DatabaseModules = Awaited<ReturnType<typeof createDatabaseModulesPromise>>;
let databaseModulesPromise: Promise<DatabaseModules> | null = null;

/**
 * 获取可复用的数据库模块加载结果。
 *
 * @returns 首次调用创建、后续调用共享的模块加载 Promise。
 * @throws 动态导入失败时透传错误，并清空缓存以允许下次调用重试。
 * @remarks 首次调用会启动模块加载；并发调用共享同一进行中的 Promise。
 */
function loadDatabaseModules(): Promise<DatabaseModules> {
  if (!databaseModulesPromise) {
    databaseModulesPromise = createDatabaseModulesPromise().catch((error) => {
      databaseModulesPromise = null;
      throw error;
    });
  }
  return databaseModulesPromise;
}

const databaseExternalApiKeyRepository: ExternalApiKeyRepository = {
  /**
   * 读取指定用户的全部密钥及其当前分组。
   *
   * @param userId 用于限定所有权范围的用户 ID。
   * @returns 按创建时间倒序排列的安全密钥行和可空当前分组。
   * @throws 数据库模块加载或查询失败时透传错误。
   * @remarks 执行只读 left join，使已禁用的当前分组仍可被识别。
   */
  async listByUser(userId) {
    const [{ db }, { externalApiKey, imageBackendGroup }, { desc, eq }] =
      await loadDatabaseModules();
    const rows = await db
      .select({
        key: selectExternalApiKeyFields(externalApiKey),
        currentGroup: {
          id: imageBackendGroup.id,
          name: imageBackendGroup.name,
          isEnabled: imageBackendGroup.isEnabled,
        },
      })
      .from(externalApiKey)
      .leftJoin(
        imageBackendGroup,
        eq(externalApiKey.generationGroupId, imageBackendGroup.id)
      )
      .where(eq(externalApiKey.userId, userId))
      .orderBy(desc(externalApiKey.createdAt));
    return rows as Array<{
      key: ExternalApiKeyRecord;
      currentGroup: ExternalApiKeyGroupRecord | null;
    }>;
  },

  /**
   * 插入一条仅持久化密钥哈希的记录。
   *
   * @param values 已包含所有权、哈希、展示片段和时间戳的插入字段。
   * @returns 数据库返回的安全密钥行；未返回行时为 null。
   * @throws 数据库模块加载、约束校验或插入失败时透传错误。
   * @remarks 写入数据库；返回投影不会包含 userId、哈希或明文。
   */
  async insert(values) {
    const [{ db }, { externalApiKey }] = await loadDatabaseModules();
    const [row] = await db
      .insert(externalApiKey)
      .values(values)
      .returning(selectExternalApiKeyFields(externalApiKey));
    return (row as ExternalApiKeyRecord | undefined) ?? null;
  },

  /**
   * 原子撤销指定用户当前启用的密钥。
   *
   * @param userId 用于限定所有权范围的用户 ID。
   * @param keyId 待撤销的密钥 ID。
   * @param updatedAt 由服务层统一生成的更新时间。
   * @returns 实际更新的安全密钥行；条件未命中时为 null。
   * @throws 数据库模块加载或更新失败时透传错误。
   * @remarks 仅在用户、密钥 ID 和启用态同时匹配时写入。
   */
  async revokeActive(userId, keyId, updatedAt) {
    const [{ db }, { externalApiKey }, { and, eq }] =
      await loadDatabaseModules();
    const [row] = await db
      .update(externalApiKey)
      .set({ isActive: false, updatedAt })
      .where(
        and(
          eq(externalApiKey.id, keyId),
          eq(externalApiKey.userId, userId),
          eq(externalApiKey.isActive, true)
        )
      )
      .returning(selectExternalApiKeyFields(externalApiKey));
    return (row as ExternalApiKeyRecord | undefined) ?? null;
  },

  /**
   * 原子删除指定用户已经撤销的密钥。
   *
   * @param userId 用于限定所有权范围的用户 ID。
   * @param keyId 待删除的密钥 ID。
   * @returns 被删除记录的 ID；条件未命中时为 null。
   * @throws 数据库模块加载或删除失败时透传错误。
   * @remarks 仅在用户、密钥 ID 和撤销态同时匹配时永久删除记录。
   */
  async deleteRevoked(userId, keyId) {
    const [{ db }, { externalApiKey }, { and, eq }] =
      await loadDatabaseModules();
    const [row] = await db
      .delete(externalApiKey)
      .where(
        and(
          eq(externalApiKey.id, keyId),
          eq(externalApiKey.userId, userId),
          eq(externalApiKey.isActive, false)
        )
      )
      .returning({ id: externalApiKey.id });
    return row ?? null;
  },

  /**
   * 原子更新指定用户启用密钥的后端分组。
   *
   * @param userId 用于限定所有权范围的用户 ID。
   * @param keyId 待更新的密钥 ID。
   * @param generationGroupId 新分组 ID；null 表示使用默认分组。
   * @param updatedAt 由服务层统一生成的更新时间。
   * @returns 实际更新的安全密钥行；条件未命中时为 null。
   * @throws 数据库模块加载、约束校验或更新失败时透传错误。
   * @remarks 仅在用户、密钥 ID 和启用态同时匹配时写入。
   */
  async updateActiveGroup(userId, keyId, generationGroupId, updatedAt) {
    const [{ db }, { externalApiKey }, { and, eq }] =
      await loadDatabaseModules();
    const [row] = await db
      .update(externalApiKey)
      .set({ generationGroupId, updatedAt })
      .where(
        and(
          eq(externalApiKey.id, keyId),
          eq(externalApiKey.userId, userId),
          eq(externalApiKey.isActive, true)
        )
      )
      .returning(selectExternalApiKeyFields(externalApiKey));
    return (row as ExternalApiKeyRecord | undefined) ?? null;
  },

  /**
   * 原子更新指定用户启用密钥的积分额度上限。
   *
   * @param userId 用于限定所有权范围的用户 ID。
   * @param keyId 待更新的密钥 ID。
   * @param creditLimit 已归一化的额度；null 表示不限额。
   * @param updatedAt 由服务层统一生成的更新时间。
   * @returns 实际更新的安全密钥行；条件未命中时为 null。
   * @throws 数据库模块加载、约束校验或更新失败时透传错误。
   * @remarks 仅在用户、密钥 ID 和启用态同时匹配时写入。
   */
  async updateActiveQuota(userId, keyId, creditLimit, updatedAt) {
    const [{ db }, { externalApiKey }, { and, eq }] =
      await loadDatabaseModules();
    const [row] = await db
      .update(externalApiKey)
      .set({ creditLimit, updatedAt })
      .where(
        and(
          eq(externalApiKey.id, keyId),
          eq(externalApiKey.userId, userId),
          eq(externalApiKey.isActive, true)
        )
      )
      .returning(selectExternalApiKeyFields(externalApiKey));
    return (row as ExternalApiKeyRecord | undefined) ?? null;
  },

  /**
   * 读取条件 mutation 未命中后的真实生命周期状态。
   *
   * @param userId 用于限定所有权范围的用户 ID。
   * @param keyId 待读取的密钥 ID。
   * @returns 当前启用状态；用户范围内不存在该密钥时为 null。
   * @throws 数据库模块加载或查询失败时透传错误。
   * @remarks 执行只读查询，用于区分不存在与状态冲突。
   */
  async findState(userId, keyId) {
    const [{ db }, { externalApiKey }, { and, eq }] =
      await loadDatabaseModules();
    const [row] = await db
      .select({ isActive: externalApiKey.isActive })
      .from(externalApiKey)
      .where(
        and(eq(externalApiKey.id, keyId), eq(externalApiKey.userId, userId))
      )
      .limit(1);
    return row ?? null;
  },
};

/** 默认生产服务；仅在实际调用时加载数据库与分组实现。 */
export const externalApiKeyManagementService =
  createExternalApiKeyManagementService({
    repository: databaseExternalApiKeyRepository,
    /**
     * 读取允许用户选择的启用后端分组。
     *
     * @returns 满足用户可选条件的后端分组最小视图列表。
     * @throws 分组服务模块加载或查询失败时透传错误。
     * @remarks 动态加载分组服务并执行只读查询。
     */
    async listSelectableGroups() {
      const { listSelectableImageBackendGroups } = await import(
        "@/features/image-backend-pool/catalog-service"
      );
      return listSelectableImageBackendGroups();
    },
    /**
     * 按 ID 读取密钥当前引用的后端分组。
     *
     * @param groupId 待查询的后端分组 ID。
     * @returns 分组最小视图；记录不存在时为 null。
     * @throws 数据库模块加载或查询失败时透传错误。
     * @remarks 执行只读查询，不要求分组当前启用或用户可选。
     */
    async getGroupById(groupId) {
      const [{ db }, { imageBackendGroup }, { eq }] =
        await loadDatabaseModules();
      const [row] = await db
        .select({
          id: imageBackendGroup.id,
          name: imageBackendGroup.name,
          isEnabled: imageBackendGroup.isEnabled,
        })
        .from(imageBackendGroup)
        .where(eq(imageBackendGroup.id, groupId))
        .limit(1);
      return row ?? null;
    },
    createId: nanoid,
    createSecret: createApiKey,
    hashSecret: hashApiKey,
    /**
     * 获取本次 mutation 使用的当前时间。
     *
     * @returns 调用时刻的新 `Date` 实例。
     * @throws 不主动抛错。
     * @remarks 读取系统时钟，不修改外部状态。
     */
    now: () => new Date(),
  });
