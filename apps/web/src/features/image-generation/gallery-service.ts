/**
 * 本人图库的卡片级 keyset 读取服务。
 *
 * 使用方：`image.listMyGallery` UOL binding。服务负责签名并校验主体、页签、批大小、
 * 固定浏览上界与卡片排序键，仓储只执行有界 PostgreSQL 查询和安全 DTO 适配。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type GalleryItem,
  type GalleryListOutput,
  type GalleryTab,
  galleryListInputSchema,
  galleryListOutputSchema,
} from "@repo/shared/image-generation/gallery-contract";
import { z } from "zod";

const GALLERY_CURSOR_VERSION = 1;
const GALLERY_CURSOR_DOMAIN = "fluxmedia:gallery:cursor:v1";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_LENGTH = 4096;

const galleryCursorPayloadSchema = z
  .object({
    v: z.literal(GALLERY_CURSOR_VERSION),
    sub: z.string().min(1).max(512),
    tab: z.enum(["final", "uploads", "videos"]),
    limit: z.number().int().min(1).max(50),
    asOf: z.string().datetime({ offset: true }),
    sortKey: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        id: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

/** 仓储 keyset 边界；上传图的 id 已包含父任务和输入位置，可稳定到卡片粒度。 */
export interface GalleryCursorKey {
  createdAt: Date;
  id: string;
}

/** 仓储读取输入，所有身份和浏览上界均由服务端生成或验证。 */
export interface GalleryListQuery {
  userId: string;
  tab: GalleryTab;
  asOf: Date;
  cursor: GalleryCursorKey | null;
  limit: number;
}

/** 带内部排序键的安全卡片；内部字段不会穿过共享输出 schema。 */
export interface GalleryListRow {
  item: GalleryItem;
  sortKey: GalleryCursorKey;
}

/** 图库仓储端口；每次请求只允许读取 limit+1 张卡片。 */
export interface GalleryRepository {
  readItems(query: GalleryListQuery): Promise<GalleryListRow[]>;
}

/** 不包含主体、游标和内部 SQL 的稳定校验错误。 */
export class GalleryServiceError extends Error {
  readonly code = "validation_error" as const;

  /** 创建可安全映射到 UOL 的图库输入错误。 */
  constructor(message = "Invalid gallery query") {
    super(message);
    this.name = "GalleryServiceError";
  }
}

/** 获取测试注入或生产认证密钥；缺失配置不能签发可伪造 cursor。 */
function resolveCursorSecret(secret?: string): string {
  const value = secret ?? process.env.BETTER_AUTH_SECRET;
  if (!value?.trim()) {
    throw new Error("BETTER_AUTH_SECRET is required for gallery cursors");
  }
  return value;
}

/** 使用图库独立域标签签名 payload，避免 token 被其他功能复用。 */
function signCursorPayload(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(GALLERY_CURSOR_DOMAIN)
    .update("\0")
    .update(payload)
    .digest();
}

/** 签发主体、页签、批大小、浏览上界和最后卡片绑定的下一边界。 */
export function encodeGalleryCursor(
  input: {
    userId: string;
    tab: GalleryTab;
    limit: number;
    asOf: Date;
    sortKey: GalleryCursorKey;
  },
  secret?: string
): string {
  const resolvedSecret = resolveCursorSecret(secret);
  const payload = galleryCursorPayloadSchema.parse({
    v: GALLERY_CURSOR_VERSION,
    sub: input.userId,
    tab: input.tab,
    limit: input.limit,
    asOf: input.asOf.toISOString(),
    sortKey: {
      createdAt: input.sortKey.createdAt.toISOString(),
      id: input.sortKey.id,
    },
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  );
  const signature = signCursorPayload(encodedPayload, resolvedSecret).toString(
    "base64url"
  );
  return `${encodedPayload}.${signature}`;
}

/** 校验 token 编码、HMAC、主体、页签、批大小和服务端时间上界。 */
function decodeGalleryCursor(
  token: string,
  expected: {
    userId: string;
    tab: GalleryTab;
    limit: number;
    asOfNotAfter: Date;
  },
  secret?: string
): { asOf: Date; sortKey: GalleryCursorKey } {
  try {
    if (!token || token.length > MAX_CURSOR_LENGTH) {
      throw new GalleryServiceError();
    }
    const [payloadPart, signaturePart, extraPart] = token.split(".");
    if (
      !payloadPart ||
      !signaturePart ||
      extraPart !== undefined ||
      !BASE64URL_PATTERN.test(payloadPart) ||
      !BASE64URL_PATTERN.test(signaturePart)
    ) {
      throw new GalleryServiceError();
    }
    const payloadBytes = Buffer.from(payloadPart, "base64url");
    const signatureBytes = Buffer.from(signaturePart, "base64url");
    if (
      payloadBytes.toString("base64url") !== payloadPart ||
      signatureBytes.toString("base64url") !== signaturePart
    ) {
      throw new GalleryServiceError();
    }
    const expectedSignature = signCursorPayload(
      payloadPart,
      resolveCursorSecret(secret)
    );
    if (
      signatureBytes.length !== expectedSignature.length ||
      !timingSafeEqual(signatureBytes, expectedSignature)
    ) {
      throw new GalleryServiceError();
    }
    const payload = galleryCursorPayloadSchema.parse(
      JSON.parse(payloadBytes.toString("utf8")) as unknown
    );
    const asOf = new Date(payload.asOf);
    const createdAt = new Date(payload.sortKey.createdAt);
    if (
      payload.sub !== expected.userId ||
      payload.tab !== expected.tab ||
      payload.limit !== expected.limit ||
      asOf > expected.asOfNotAfter ||
      createdAt > asOf
    ) {
      throw new GalleryServiceError();
    }
    return { asOf, sortKey: { createdAt, id: payload.sortKey.id } };
  } catch (error) {
    if (error instanceof GalleryServiceError) throw error;
    throw new GalleryServiceError();
  }
}

/**
 * 读取当前主体的一批图库卡片。
 *
 * @param request 当前主体、不可信输入和可选测试时间。
 * @param dependencies 有界仓储与可选测试签名密钥。
 * @returns 安全卡片和签名下一边界；非法 cursor 显式失败，由传输层保留现有列表重试。
 */
export async function loadGalleryItems(
  request: { userId: string; input: unknown; now?: Date },
  dependencies: { repository: GalleryRepository; tokenSecret?: string }
): Promise<GalleryListOutput> {
  const parsed = galleryListInputSchema.parse(request.input);
  const serverNow = request.now ?? new Date();
  let asOf = serverNow;
  let cursor: GalleryCursorKey | null = null;
  if (parsed.cursor) {
    const decoded = decodeGalleryCursor(
      parsed.cursor,
      {
        userId: request.userId,
        tab: parsed.tab,
        limit: parsed.limit,
        asOfNotAfter: serverNow,
      },
      dependencies.tokenSecret
    );
    asOf = decoded.asOf;
    cursor = decoded.sortKey;
  }
  const rows = await dependencies.repository.readItems({
    userId: request.userId,
    tab: parsed.tab,
    asOf,
    cursor,
    limit: parsed.limit + 1,
  });
  const hasMore = rows.length > parsed.limit;
  const selectedRows = rows.slice(0, parsed.limit);
  const last = selectedRows.at(-1) ?? null;
  return galleryListOutputSchema.parse({
    items: selectedRows.map((row) => row.item),
    nextCursor:
      hasMore && last
        ? encodeGalleryCursor(
            {
              userId: request.userId,
              tab: parsed.tab,
              limit: parsed.limit,
              asOf,
              sortKey: last.sortKey,
            },
            dependencies.tokenSecret
          )
        : null,
  });
}
