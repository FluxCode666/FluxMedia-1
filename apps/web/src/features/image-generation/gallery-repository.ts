/**
 * 本人图库的 PostgreSQL 卡片仓储。
 *
 * 使用方：gallery service。成品和视频按任务唯一键读取；上传图使用 JSON 数组序号
 * 展开为卡片级排序键，保证一个任务包含多张参考图时 keyset 不跳项、不重复。
 */

import { db } from "@repo/database";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { extractExecuteRows } from "@/server/database-result";
import type {
  GalleryListQuery,
  GalleryListRow,
  GalleryRepository,
} from "./gallery-service";
import {
  extractGenerationReferenceImages,
  extractPromptRepairNotice,
} from "./generation-metadata";

const finalRowSchema = z.object({
  id: z.string().min(1).max(512),
  prompt: z.string(),
  revised_prompt: z.string().nullable(),
  model: z.string().min(1).max(240),
  size: z.string().min(1).max(200),
  credits_consumed: z.coerce.number().finite().nonnegative(),
  storage_key: z.string().nullable(),
  storage_bucket: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.coerce.date(),
  sort_id: z.string().min(1).max(512),
});

const uploadRowSchema = finalRowSchema.extend({
  input_index: z.coerce.number().int().nonnegative(),
});

const videoRowSchema = z.object({
  id: z.string().min(1).max(512),
  prompt: z.string(),
  model: z.string().min(1).max(240),
  duration_seconds: z.coerce.number().int().positive(),
  aspect_ratio: z.string().min(1).max(100),
  resolution: z.string().min(1).max(100),
  credits_consumed: z.coerce.number().finite().nonnegative(),
  storage_key: z.string().nullable(),
  storage_bucket: z.string().nullable(),
  created_at: z.coerce.date(),
  sort_id: z.string().min(1).max(512),
});

/** 构造严格小于卡片排序键的下一页谓词。 */
function buildCursorPredicate(input: GalleryListQuery): SQL {
  if (!input.cursor) return sql`true`;
  return sql`(created_at, sort_id) < (${input.cursor.createdAt}, ${input.cursor.id})`;
}

/** 构造成品卡片的有界 keyset 查询。 */
export function buildFinalGallerySql(input: GalleryListQuery): SQL {
  const cursorPredicate = input.cursor
    ? sql`and (g.created_at, g.id) < (${input.cursor.createdAt}, ${input.cursor.id})`
    : sql``;
  return sql`
    select
      g.id::text as id,
      g.prompt::text as prompt,
      g.revised_prompt::text as revised_prompt,
      g.model::text as model,
      g.size::text as size,
      g.credits_consumed::numeric as credits_consumed,
      g.storage_key::text as storage_key,
      g.storage_bucket::text as storage_bucket,
      g.metadata::jsonb as metadata,
      g.created_at,
      g.id::text as sort_id
    from generation g
    where g.user_id = ${input.userId}
      and g.status = 'completed'
      and g.storage_key is not null
      and g.created_at <= ${input.asOf}
      ${cursorPredicate}
    order by g.created_at desc, g.id desc
    limit ${input.limit}
  `;
}

/** 构造上传图卡片的 JSON 数组展开查询。 */
export function buildUploadGallerySql(input: GalleryListQuery): SQL {
  return sql`
    with upload_cards as (
      select
        g.id::text as id,
        g.prompt::text as prompt,
        g.revised_prompt::text as revised_prompt,
        g.model::text as model,
        g.size::text as size,
        0::numeric as credits_consumed,
        null::text as storage_key,
        null::text as storage_bucket,
        g.metadata::jsonb as metadata,
        g.created_at,
        (input_image.ordinality - 1)::integer as input_index,
        format(
          '%s-upload-%s',
          g.id,
          lpad((100000000 - input_image.ordinality)::text, 9, '0')
        )::text as sort_id
      from generation g
      cross join lateral jsonb_array_elements(
        coalesce((g.metadata::jsonb)->'inputImages'->'images', '[]'::jsonb)
      ) with ordinality as input_image(value, ordinality)
      where g.user_id = ${input.userId}
        and g.created_at <= ${input.asOf}
        and (
          nullif(btrim(input_image.value->>'imageUrl'), '') is not null
          or (
            nullif(btrim(input_image.value->>'storageKey'), '') is not null
            and nullif(btrim(input_image.value->>'storageBucket'), '') is not null
          )
        )
    )
    select *
    from upload_cards
    where ${buildCursorPredicate(input)}
    order by created_at desc, sort_id desc
    limit ${input.limit}
  `;
}

/** 构造视频卡片的有界 keyset 查询。 */
export function buildVideoGallerySql(input: GalleryListQuery): SQL {
  const cursorPredicate = input.cursor
    ? sql`and (v.created_at, v.id) < (${input.cursor.createdAt}, ${input.cursor.id})`
    : sql``;
  return sql`
    select
      v.id::text as id,
      v.prompt::text as prompt,
      v.model::text as model,
      v.duration_seconds::integer as duration_seconds,
      v.aspect_ratio::text as aspect_ratio,
      v.resolution::text as resolution,
      v.credits_consumed::numeric as credits_consumed,
      v.storage_key::text as storage_key,
      v.storage_bucket::text as storage_bucket,
      v.created_at,
      v.id::text as sort_id
    from video_generation v
    where v.user_id = ${input.userId}
      and v.status = 'completed'
      and v.storage_key is not null
      and v.created_at <= ${input.asOf}
      ${cursorPredicate}
    order by v.created_at desc, v.id desc
    limit ${input.limit}
  `;
}

/** 删除参考图内部存储坐标，只保留共享 lightbox 安全字段。 */
function toSafeReferenceImages(metadata: Record<string, unknown> | null) {
  return extractGenerationReferenceImages(metadata)
    .slice(0, 50)
    .map(({ storageBucket: _bucket, storageKey: _key, ...safe }) => safe);
}

/** 将成品查询行映射为安全卡片和内部排序键。 */
function adaptFinalRows(rows: unknown[]): GalleryListRow[] {
  return z
    .array(finalRowSchema)
    .parse(rows)
    .map((row) => ({
      item: {
        id: row.id,
        parentId: row.id,
        prompt: row.prompt,
        revisedPrompt: row.revised_prompt,
        promptRepairNotice: extractPromptRepairNotice(row.metadata),
        model: row.model,
        size: row.size,
        status: "completed",
        creditsConsumed: row.credits_consumed,
        imageUrl: buildSignedStorageImageUrl(
          row.storage_key,
          row.storage_bucket
        ),
        createdAt: row.created_at.toISOString(),
        outputRole: "final",
        referenceImages: toSafeReferenceImages(row.metadata),
      },
      sortKey: { createdAt: row.created_at, id: row.sort_id },
    }));
}

/** 将上传图查询行映射为一张参考图卡片；损坏的数组成员会显式失败。 */
function adaptUploadRows(rows: unknown[]): GalleryListRow[] {
  return z
    .array(uploadRowSchema)
    .parse(rows)
    .map((row) => {
      const referenceImages = extractGenerationReferenceImages(row.metadata);
      const image = referenceImages.find(
        (referenceImage) => referenceImage.index === row.input_index
      );
      if (!image) throw new RangeError("Gallery upload image is invalid");
      const megabytes =
        image.sizeBytes && image.sizeBytes > 0
          ? image.sizeBytes / 1024 / 1024
          : null;
      return {
        item: {
          id: `${row.id}-upload-${image.id || row.input_index + 1}`,
          parentId: row.id,
          prompt: row.prompt,
          revisedPrompt: row.revised_prompt,
          promptRepairNotice: extractPromptRepairNotice(row.metadata),
          model: image.type || "User upload",
          size:
            megabytes === null
              ? "Uploaded"
              : `${megabytes >= 0.1 ? megabytes.toFixed(1) : "<0.1"} MB`,
          status: "completed",
          creditsConsumed: 0,
          imageUrl: image.imageUrl,
          createdAt: row.created_at.toISOString(),
          outputRole: "upload",
          referenceImages: toSafeReferenceImages(row.metadata),
        },
        sortKey: { createdAt: row.created_at, id: row.sort_id },
      };
    });
}

/** 将视频查询行映射为安全卡片和内部排序键。 */
function adaptVideoRows(rows: unknown[]): GalleryListRow[] {
  return z
    .array(videoRowSchema)
    .parse(rows)
    .map((row) => ({
      item: {
        id: row.id,
        parentId: row.id,
        prompt: row.prompt,
        model: row.model,
        size: `${row.duration_seconds}s · ${row.aspect_ratio} · ${row.resolution}`,
        status: "completed",
        creditsConsumed: row.credits_consumed,
        videoUrl: buildSignedStorageImageUrl(
          row.storage_key,
          row.storage_bucket
        ),
        createdAt: row.created_at.toISOString(),
        outputRole: "video",
      },
      sortKey: { createdAt: row.created_at, id: row.sort_id },
    }));
}

/** 生产图库仓储；switch 保证只查询当前页签，不读取或计算其他页签数据。 */
export const databaseGalleryRepository: GalleryRepository = {
  async readItems(query) {
    if (query.tab === "uploads") {
      return adaptUploadRows(
        extractExecuteRows(await db.execute(buildUploadGallerySql(query)))
      );
    }
    if (query.tab === "videos") {
      return adaptVideoRows(
        extractExecuteRows(await db.execute(buildVideoGallerySql(query)))
      );
    }
    return adaptFinalRows(
      extractExecuteRows(await db.execute(buildFinalGallerySql(query)))
    );
  },
};
