import {
  type ImageSizeConfigInput,
  type ImageSizeConfigSnapshot,
  imageSizeConfigInputSchema,
} from "@repo/shared/image-backend/image-size-config";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

import { extractExecuteRows } from "@/server/database-result";
import {
  type BoundImageSizeConfigAdapter,
  canonicalizeImageSizeConfigSnapshot,
  IMAGE_SIZE_CONFIG_BINDING_LOCK_QUERY,
  refreshBoundImageSizeConfigAdapters,
} from "./image-size-config-binding";

export type ImageSizeConfigSummary = ImageSizeConfigSnapshot & {
  createdAt: string;
  updatedAt: string;
};

const boundAdapterRowSchema = z.object({
  member_id: z.string(),
  current_adapter_version_id: z.string(),
  revision: z.coerce.number().int().positive(),
  credential_scope: z.string(),
  configuration: z.unknown(),
});

interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

/** 构造当前绑定版本查询；锁住版本指针，供同一事务内执行 CAS 切换。 */
export function buildBoundImageSizeConfigAdaptersQuery(configId: string): SQL {
  return sql`
    with target as (select ${configId}::text as id)
    select
      api.member_id,
      api.current_adapter_version_id,
      version.revision,
      version.credential_scope,
      version.configuration
    from image_backend_member_api_config as api
    cross join target
    inner join image_backend_member_api_adapter_version as version
      on version.member_id_snapshot = api.member_id
      and version.id = api.current_adapter_version_id
    where version.configuration::jsonb #>> '{imageSizeConfig,id}' = target.id
       or exists (
         select 1
         from jsonb_each(version.configuration::jsonb -> 'imageSizeConfigsByModel') as model_config(model_id, config)
         where model_config.config ->> 'id' = target.id
       )
    order by api.member_id asc
    for update of api
  `;
}

/** 在已持有绑定事务锁时读取当前仍引用指定配置的供应商版本。 */
async function loadBoundAdapters(
  executor: SqlExecutor,
  configId: string
): Promise<BoundImageSizeConfigAdapter[]> {
  const rows = z
    .array(boundAdapterRowSchema)
    .parse(
      extractExecuteRows(
        await executor.execute(buildBoundImageSizeConfigAdaptersQuery(configId))
      )
    );
  return rows.map((row) => ({
    memberId: row.member_id,
    currentAdapterVersionId: row.current_adapter_version_id,
    revision: row.revision,
    credentialScope: row.credential_scope,
    configuration: row.configuration,
  }));
}

export async function listImageSizeConfigs(): Promise<
  ImageSizeConfigSummary[]
> {
  const { db, imageSizeConfig, imageSizeConfigMapping } = await import(
    "@repo/database"
  );
  return db.transaction(
    async (tx) => {
      const configs = await tx.select().from(imageSizeConfig);
      const mappings = await tx.select().from(imageSizeConfigMapping);
      return configs.map((config) => {
        const configMappings = mappings
          .filter((mapping) => mapping.configId === config.id)
          .map((mapping) => ({
            resolution: mapping.resolution,
            aspectRatio: mapping.aspectRatio,
            size: mapping.size,
          }));
        const snapshot = canonicalizeImageSizeConfigSnapshot({
          id: config.id,
          name: config.name,
          mappings: configMappings,
        });
        return {
          ...snapshot,
          createdAt: config.createdAt.toISOString(),
          updatedAt: config.updatedAt.toISOString(),
        };
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}

export async function getImageSizeConfigSnapshot(
  id: string
): Promise<ImageSizeConfigSnapshot | null> {
  const all = await listImageSizeConfigs();
  const found = all.find((config) => config.id === id);
  return found
    ? { id: found.id, name: found.name, mappings: found.mappings }
    : null;
}

export async function saveImageSizeConfig(
  rawInput: unknown
): Promise<{ id: string }> {
  const input = imageSizeConfigInputSchema.parse(rawInput);
  const id = input.id ?? nanoid();
  const {
    db,
    imageBackendMemberApiAdapterVersion,
    imageBackendMemberApiConfig,
    imageSizeConfig,
    imageSizeConfigMapping,
  } = await import("@repo/database");
  await db.transaction(async (tx) => {
    await tx.execute(IMAGE_SIZE_CONFIG_BINDING_LOCK_QUERY);
    const now = new Date();
    const saved = await tx
      .insert(imageSizeConfig)
      .values({ id, name: input.name, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: imageSizeConfig.id,
        set: { name: input.name, updatedAt: now },
      })
      .returning({ id: imageSizeConfig.id });
    if (saved.length !== 1) {
      throw new Error(`尺寸配置 ${id} 保存结果异常`);
    }
    await tx
      .delete(imageSizeConfigMapping)
      .where(eq(imageSizeConfigMapping.configId, id));
    await tx.insert(imageSizeConfigMapping).values(
      input.mappings.map((mapping) => ({
        id: nanoid(),
        configId: id,
        ...mapping,
        createdAt: now,
      }))
    );
    const snapshot = canonicalizeImageSizeConfigSnapshot({
      id,
      name: input.name,
      mappings: input.mappings,
    });
    await refreshBoundImageSizeConfigAdapters({
      configId: id,
      snapshot,
      now,
      createId: nanoid,
      loadBoundAdapters: () => loadBoundAdapters(tx, id),
      async insertVersion(version) {
        await tx.insert(imageBackendMemberApiAdapterVersion).values(version);
      },
      async switchCurrentVersion(version) {
        const switched = await tx
          .update(imageBackendMemberApiConfig)
          .set({
            currentAdapterVersionId: version.nextVersionId,
            updatedAt: version.updatedAt,
          })
          .where(
            and(
              eq(imageBackendMemberApiConfig.memberId, version.memberId),
              eq(
                imageBackendMemberApiConfig.currentAdapterVersionId,
                version.expectedCurrentVersionId
              )
            )
          )
          .returning({ id: imageBackendMemberApiConfig.memberId });
        if (switched.length > 1) {
          throw new Error(`供应商 ${version.memberId} 当前版本更新了多行`);
        }
        return switched.length === 1;
      },
    });
  });
  return { id };
}

export async function deleteImageSizeConfig(
  id: string
): Promise<{ success: boolean }> {
  const {
    db,
    imageBackendMemberApiAdapterVersion,
    imageBackendMemberApiConfig,
    imageSizeConfig,
  } = await import("@repo/database");
  return db.transaction(async (tx) => {
    await tx.execute(IMAGE_SIZE_CONFIG_BINDING_LOCK_QUERY);
    const now = new Date();
    await refreshBoundImageSizeConfigAdapters({
      configId: id,
      snapshot: null,
      now,
      createId: nanoid,
      loadBoundAdapters: () => loadBoundAdapters(tx, id),
      async insertVersion(version) {
        await tx.insert(imageBackendMemberApiAdapterVersion).values(version);
      },
      async switchCurrentVersion(version) {
        const switched = await tx
          .update(imageBackendMemberApiConfig)
          .set({
            currentAdapterVersionId: version.nextVersionId,
            updatedAt: version.updatedAt,
          })
          .where(
            and(
              eq(imageBackendMemberApiConfig.memberId, version.memberId),
              eq(
                imageBackendMemberApiConfig.currentAdapterVersionId,
                version.expectedCurrentVersionId
              )
            )
          )
          .returning({ id: imageBackendMemberApiConfig.memberId });
        if (switched.length > 1) {
          throw new Error(`供应商 ${version.memberId} 当前版本更新了多行`);
        }
        return switched.length === 1;
      },
    });
    const deleted = await tx
      .delete(imageSizeConfig)
      .where(eq(imageSizeConfig.id, id))
      .returning({ id: imageSizeConfig.id });
    if (deleted.length > 1) {
      throw new Error(`尺寸配置 ${id} 删除了多行`);
    }
    return { success: deleted.length === 1 };
  });
}

export function parseImageSizeConfigInput(
  value: unknown
): ImageSizeConfigInput {
  return imageSizeConfigInputSchema.parse(value);
}
