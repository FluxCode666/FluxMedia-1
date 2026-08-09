/**
 * 生成媒体删除服务。
 *
 * 使用方：image.delete / image.batchDelete UOL binding。用户删除只移除不再共享的
 * 存储对象和画廊引用，保留 generation 任务、计费字段及成功产物用量事实。
 */
import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import {
  collectGenerationImageStorageReferences,
  type GenerationImageStorageReference,
  stripDestroyedGenerationImageReferences,
} from "@repo/shared/generation-maintenance";
import { logError } from "@repo/shared/logger";
import { getStorageProvider } from "@repo/shared/storage/providers";
import { and, eq, inArray, notInArray } from "drizzle-orm";

type GenerationDeletionRecord = {
  id: string;
  userId: string;
  storageKey: string | null;
  storageBucket: string | null;
  metadata: Record<string, unknown> | null;
};

type GenerationTombstoneUpdate = {
  id: string;
  userId: string;
  metadata: Record<string, unknown>;
};

/** 删除编排依赖；测试使用内存实现，生产适配器负责数据库与对象存储。 */
export type GenerationDeletionDependencies = {
  loadOwned: (
    userId: string,
    generationIds: readonly string[]
  ) => Promise<GenerationDeletionRecord[]>;
  loadOther: (
    userId: string,
    excludedGenerationIds: readonly string[]
  ) => Promise<GenerationDeletionRecord[]>;
  deleteObject: (reference: GenerationImageStorageReference) => Promise<void>;
  markMediaDeleted: (
    updates: readonly GenerationTombstoneUpdate[]
  ) => Promise<number>;
  reportStorageError: (
    error: unknown,
    context: { userId: string; generationCount: number }
  ) => void;
  now: () => Date;
};

/**
 * 读取单条 generation 的资源所有者，供 owner UOL binding 执行统一归属断言。
 *
 * @param generationId 已验证的任务 ID。
 * @returns 不存在时为 null，否则返回 owner userId；无写副作用。
 */
export async function readGenerationOwnerId(
  generationId: string
): Promise<string | null> {
  const [row] = await db
    .select({ userId: generation.userId })
    .from(generation)
    .where(eq(generation.id, generationId))
    .limit(1);
  return row?.userId ?? null;
}

/** 生成稳定的 bucket/key 去重键。 */
function referenceKey(reference: GenerationImageStorageReference): string {
  return `${reference.bucket}:${reference.key}`;
}

/**
 * 删除本人生成媒体并把 generation 更新为不可见墓碑。
 *
 * @param input 当前用户和最多 100 个已验证任务 ID。
 * @param dependencies 数据库、存储、日志与时钟依赖。
 * @returns 实际更新为媒体墓碑的任务数；不存在或重复删除返回 0 或已有行数。
 * @sideEffects 尽力删除对象存储文件，并原子更新命中的 generation 行。
 */
export async function deleteGenerationMediaWithDependencies(
  input: { userId: string; generationIds: readonly string[] },
  dependencies: GenerationDeletionDependencies
): Promise<{ deletedCount: number }> {
  const owned = await dependencies.loadOwned(input.userId, input.generationIds);
  if (owned.length === 0) return { deletedCount: 0 };

  const referencesByKey = new Map<string, GenerationImageStorageReference>();
  for (const row of owned) {
    for (const reference of collectGenerationImageStorageReferences(row)) {
      referencesByKey.set(referenceKey(reference), reference);
    }
  }

  const deletableReferenceKeys = new Set(referencesByKey.keys());
  if (deletableReferenceKeys.size > 0) {
    const otherRows = await dependencies.loadOther(
      input.userId,
      owned.map((row) => row.id)
    );
    for (const row of otherRows) {
      for (const reference of collectGenerationImageStorageReferences(row)) {
        deletableReferenceKeys.delete(referenceKey(reference));
      }
    }
  }

  const deletedReferenceKeys = new Set<string>();
  try {
    for (const referenceKeyValue of deletableReferenceKeys) {
      const reference = referencesByKey.get(referenceKeyValue);
      if (!reference) continue;
      await dependencies.deleteObject(reference);
      deletedReferenceKeys.add(referenceKeyValue);
    }
  } catch (error) {
    dependencies.reportStorageError(error, {
      userId: input.userId,
      generationCount: owned.length,
    });
  }

  const destroyedAt = dependencies.now().toISOString();
  const updates = owned.map((row) => {
    const storageObjectsDeleted = collectGenerationImageStorageReferences(
      row
    ).filter((reference) =>
      deletedReferenceKeys.has(referenceKey(reference))
    ).length;
    return {
      id: row.id,
      userId: row.userId,
      metadata: stripDestroyedGenerationImageReferences(row.metadata, {
        destroyedAt,
        retentionHours: 0,
        storageObjectsDeleted,
        reason: "user_deleted",
      }),
    };
  });

  return { deletedCount: await dependencies.markMediaDeleted(updates) };
}

/**
 * 使用生产数据库与对象存储删除本人生成媒体。
 *
 * @param input 当前 Principal 用户与任务 ID 列表。
 * @returns 被更新为媒体墓碑的任务数。
 * @throws 数据库读取或更新失败；对象存储失败仅记录并继续隐藏媒体引用。
 */
export async function deleteGenerationMediaForUser(input: {
  userId: string;
  generationIds: readonly string[];
}): Promise<{ deletedCount: number }> {
  let storageProvider: Awaited<ReturnType<typeof getStorageProvider>> | null =
    null;
  return deleteGenerationMediaWithDependencies(input, {
    async loadOwned(userId, generationIds) {
      return db
        .select({
          id: generation.id,
          userId: generation.userId,
          storageKey: generation.storageKey,
          storageBucket: generation.storageBucket,
          metadata: generation.metadata,
        })
        .from(generation)
        .where(
          and(
            eq(generation.userId, userId),
            inArray(generation.id, [...generationIds])
          )
        );
    },
    async loadOther(userId, excludedGenerationIds) {
      return db
        .select({
          id: generation.id,
          userId: generation.userId,
          storageKey: generation.storageKey,
          storageBucket: generation.storageBucket,
          metadata: generation.metadata,
        })
        .from(generation)
        .where(
          and(
            eq(generation.userId, userId),
            notInArray(generation.id, [...excludedGenerationIds])
          )
        );
    },
    async deleteObject(reference) {
      storageProvider ??= await getStorageProvider();
      await storageProvider.deleteObject(reference.key, reference.bucket);
    },
    async markMediaDeleted(updates) {
      return db.transaction(async (tx) => {
        let updatedCount = 0;
        for (const update of updates) {
          const [updated] = await tx
            .update(generation)
            .set({
              storageKey: null,
              fileSize: null,
              metadata: update.metadata,
            })
            .where(
              and(
                eq(generation.id, update.id),
                eq(generation.userId, update.userId)
              )
            )
            .returning({ id: generation.id });
          if (updated) updatedCount += 1;
        }
        return updatedCount;
      });
    },
    reportStorageError(error, context) {
      logError(error, {
        source: "generation-user-delete",
        userId: context.userId,
        generationCount: context.generationCount,
      });
    },
    now: () => new Date(),
  });
}
