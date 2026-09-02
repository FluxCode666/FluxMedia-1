/**
 * 图片尺寸配置与供应商当前适配版本之间的一致性工具。
 *
 * 尺寸配置本身可变，适配版本不可变；配置变更通过创建新版本并原子切换当前指针
 * 实时生效，历史任务和已获得的租约仍继续引用旧版本。
 */

import {
  type ApiUpstreamAdapterDraft,
  apiUpstreamAdapterDraftSchema,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  type ImageSizeConfigSnapshot,
  imageSizeConfigSnapshotSchema,
  normalizeImageSizeConfigKey,
} from "@repo/shared/image-backend/image-size-config";
import { sql } from "drizzle-orm";

/**
 * 串行化尺寸配置维护和供应商保存，避免供应商把事务外读取的旧快照重新写回。
 * 两个常量均在 PostgreSQL signed int4 范围内，作为本业务域的稳定 advisory lock key。
 */
export const IMAGE_SIZE_CONFIG_BINDING_LOCK_QUERY = sql`
  select pg_advisory_xact_lock(1229801287, 1397313351)
`;

export interface BoundImageSizeConfigAdapter {
  memberId: string;
  currentAdapterVersionId: string;
  revision: number;
  credentialScope: string;
  configuration: unknown;
}

export interface RefreshedImageSizeConfigAdapterVersion {
  id: string;
  memberIdSnapshot: string;
  revision: number;
  credentialScope: string;
  configuration: ApiUpstreamAdapterDraft;
  createdAt: Date;
}

export interface RefreshBoundImageSizeConfigAdaptersDependencies {
  configId: string;
  snapshot: ImageSizeConfigSnapshot | null;
  now: Date;
  createId: () => string;
  loadBoundAdapters(): Promise<BoundImageSizeConfigAdapter[]>;
  insertVersion(version: RefreshedImageSizeConfigAdapterVersion): Promise<void>;
  switchCurrentVersion(input: {
    memberId: string;
    expectedCurrentVersionId: string;
    nextVersionId: string;
    updatedAt: Date;
  }): Promise<boolean>;
}

/** 生成稳定顺序的配置快照，避免 DB 返回顺序引起无意义的适配版本。 */
export function canonicalizeImageSizeConfigSnapshot(
  value: unknown
): ImageSizeConfigSnapshot {
  const snapshot = imageSizeConfigSnapshotSchema.parse(value);
  const mappings = [...snapshot.mappings].sort((left, right) => {
    const leftKey = `${normalizeImageSizeConfigKey(left.resolution)}\u0000${normalizeImageSizeConfigKey(left.aspectRatio)}\u0000${left.size}`;
    const rightKey = `${normalizeImageSizeConfigKey(right.resolution)}\u0000${normalizeImageSizeConfigKey(right.aspectRatio)}\u0000${right.size}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return { ...snapshot, mappings };
}

function snapshotsEqual(
  left: ImageSizeConfigSnapshot | null,
  right: ImageSizeConfigSnapshot | null
): boolean {
  if (!left || !right) return left === right;
  return (
    JSON.stringify(canonicalizeImageSizeConfigSnapshot(left)) ===
    JSON.stringify(canonicalizeImageSizeConfigSnapshot(right))
  );
}

/**
 * 为所有当前绑定成员创建下一版适配快照并以 CAS 切换当前版本。
 * 调用方必须把加载、插入和切换放在同一数据库事务及 advisory lock 内。
 */
export async function refreshBoundImageSizeConfigAdapters(
  dependencies: RefreshBoundImageSizeConfigAdaptersDependencies
): Promise<{ scanned: number; refreshed: number }> {
  const desiredSnapshot = dependencies.snapshot
    ? canonicalizeImageSizeConfigSnapshot(dependencies.snapshot)
    : null;
  const adapters = await dependencies.loadBoundAdapters();
  let refreshed = 0;

  for (const adapter of adapters) {
    const currentConfiguration = apiUpstreamAdapterDraftSchema.parse(
      adapter.configuration
    );
    const currentSnapshot = currentConfiguration.imageSizeConfig
      ? canonicalizeImageSizeConfigSnapshot(
          currentConfiguration.imageSizeConfig
        )
      : null;
    if (snapshotsEqual(currentSnapshot, desiredSnapshot)) continue;

    const nextVersion: RefreshedImageSizeConfigAdapterVersion = {
      id: dependencies.createId(),
      memberIdSnapshot: adapter.memberId,
      revision: adapter.revision + 1,
      credentialScope: adapter.credentialScope,
      configuration: apiUpstreamAdapterDraftSchema.parse({
        ...currentConfiguration,
        imageSizeConfig: desiredSnapshot,
      }),
      createdAt: dependencies.now,
    };
    await dependencies.insertVersion(nextVersion);
    const switched = await dependencies.switchCurrentVersion({
      memberId: adapter.memberId,
      expectedCurrentVersionId: adapter.currentAdapterVersionId,
      nextVersionId: nextVersion.id,
      updatedAt: dependencies.now,
    });
    if (!switched) {
      throw new Error(
        `尺寸配置 ${dependencies.configId} 刷新供应商 ${adapter.memberId} 时发生版本冲突`
      );
    }
    refreshed += 1;
  }

  return { scanned: adapters.length, refreshed };
}
