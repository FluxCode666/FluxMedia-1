/**
 * 本人图库的 PostgreSQL 卡片仓储。
 *
 * 使用方：gallery service。成品和视频按任务唯一键读取；上传图使用 JSON 数组序号
 * 展开为卡片级排序键，保证一个任务包含多张参考图时 keyset 不跳项、不重复。
 */

import { createHmac } from "node:crypto";
import { type GalleryListOutput, galleryListOutputSchema } from "@repo/shared/image-generation/gallery-contract";
import { type SQL, sql } from "drizzle-orm";
import { requestGoJson } from "@/server/go-backend-client";
import type { GalleryListQuery, GalleryListRow, GalleryRepository } from "./gallery-service";

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

/**
 * Encode the Go gallery cursor for a decoded service cursor. The service keeps
 * its own signed cursor contract for callers; this adapter only needs to
 * present the equivalent boundary to the Go endpoint.
 */
function encodeGoGalleryCursor(query: GalleryListQuery): string | null {
  if (!query.cursor) return null;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for gallery cursors");
  const payload = {
    v: 1,
    sub: query.userId,
    tab: query.tab,
    limit: query.limit,
    asOf: query.asOf.toISOString(),
    sortCreated: query.cursor.createdAt.toISOString(),
    sortId: query.cursor.id,
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update("fluxmedia:gallery:cursor:v1\0")
    .update(raw)
    .digest("base64url");
  return `${raw.toString("base64url")}.${signature}`;
}

/**
 * Production gallery repository backed by the Go first-party endpoint.
 * `query.limit` includes the service's look-ahead row, so Go can preserve the
 * existing keyset pagination behavior while returning safe gallery DTOs.
 */
export const databaseGalleryRepository: GalleryRepository = {
  async readItems(query): Promise<GalleryListRow[]> {
    const output = await requestGoJson<GalleryListOutput>(
      "/api/image-generation/gallery",
      {
        method: "POST",
        body: JSON.stringify({
          tab: query.tab,
          limit: query.limit,
          cursor: encodeGoGalleryCursor(query),
        }),
      }
    );
    const parsed = galleryListOutputSchema.parse(output);
    return parsed.items.map((item) => ({
      item,
      sortKey: { createdAt: new Date(item.createdAt), id: item.id },
    }));
  },
};
