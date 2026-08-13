/**
 * 公告列表的 PostgreSQL 生产适配器。
 *
 * 使用方：support UOL operation。用户列表、管理员列表与管理统计均在只读
 * repeatable-read 事务内完成；全部已读使用单条 INSERT ... SELECT 集合写入。
 */
import { announcement, announcementRead } from "@repo/database/schema";
import { and, count, desc, eq, isNull, lte, or, sql } from "drizzle-orm";

import type { PaginationState } from "../pagination/state";
import type {
  AdminAnnouncementItem,
  AdminAnnouncementListOutput,
  UserAnnouncementListOutput,
  UserAnnouncementListRecord,
} from "./list-contract";
import {
  type AdminAnnouncementPageRequest,
  type AnnouncementListRepository,
  listAdminAnnouncementsPage,
  listUserAnnouncementsPage,
} from "./list-service-core";

type AnnouncementDatabase = typeof import("@repo/database")["db"];

/** 用同一个时间边界构造当前生效公告条件。 */
function activeAnnouncementFilter(now: Date) {
  return and(
    eq(announcement.isPublished, true),
    or(isNull(announcement.publishedAt), lte(announcement.publishedAt, now)),
    or(isNull(announcement.expiresAt), sql`${announcement.expiresAt} > ${now}`)
  );
}

/** 按管理员发布筛选构造查询条件。 */
function adminPublishedFilter(
  published: AdminAnnouncementPageRequest["published"]
) {
  if (published === "published") return eq(announcement.isPublished, true);
  if (published === "unpublished") return eq(announcement.isPublished, false);
  return undefined;
}

/** 将数据库用户公告行转换为严格 DTO，并把更新后的旧已读记录视为未读。 */
function serializeUserAnnouncement(row: {
  id: string;
  title: string;
  content: string;
  severity: string;
  isPinned: boolean;
  priority: number;
  publishedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  readAt: Date | null;
}): UserAnnouncementListRecord {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    severity: row.severity,
    isPinned: row.isPinned,
    priority: row.priority,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    isRead: row.readAt !== null && row.readAt >= row.updatedAt,
  };
}

/** 将数据库管理公告行转换为严格 DTO。 */
function serializeAdminAnnouncement(
  row: typeof announcement.$inferSelect
): AdminAnnouncementItem {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    severity: row.severity,
    isPublished: row.isPublished,
    isPinned: row.isPinned,
    priority: row.priority,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 创建每次调用独享的只读 repeatable-read 快照仓储。 */
function createAnnouncementListRepository(
  database: AnnouncementDatabase,
  now: Date
): AnnouncementListRepository {
  return {
    withReadSnapshot: (work) =>
      database.transaction(
        async (tx) =>
          work({
            async countActiveForUser() {
              const rows = await tx
                .select({ count: count() })
                .from(announcement)
                .where(activeAnnouncementFilter(now));
              return rows[0]?.count ?? 0;
            },
            async listActiveForUser(input) {
              const rows = await tx
                .select({
                  id: announcement.id,
                  title: announcement.title,
                  content: announcement.content,
                  severity: announcement.severity,
                  isPinned: announcement.isPinned,
                  priority: announcement.priority,
                  publishedAt: announcement.publishedAt,
                  expiresAt: announcement.expiresAt,
                  createdAt: announcement.createdAt,
                  updatedAt: announcement.updatedAt,
                  readAt: announcementRead.readAt,
                })
                .from(announcement)
                .leftJoin(
                  announcementRead,
                  and(
                    eq(announcementRead.announcementId, announcement.id),
                    eq(announcementRead.userId, input.userId)
                  )
                )
                .where(activeAnnouncementFilter(now))
                .orderBy(
                  desc(announcement.isPinned),
                  desc(announcement.priority),
                  desc(announcement.publishedAt),
                  desc(announcement.createdAt),
                  desc(announcement.id)
                )
                .limit(input.limit)
                .offset(input.offset);
              return rows.map(serializeUserAnnouncement);
            },
            async countForAdmin(published) {
              const query = tx.select({ count: count() }).from(announcement);
              const where = adminPublishedFilter(published);
              const rows = await (where ? query.where(where) : query);
              return rows[0]?.count ?? 0;
            },
            async listForAdmin(input) {
              const query = tx.select().from(announcement);
              const where = adminPublishedFilter(input.published);
              const rows = await (where ? query.where(where) : query)
                .orderBy(
                  desc(announcement.isPinned),
                  desc(announcement.updatedAt),
                  desc(announcement.id)
                )
                .limit(input.limit)
                .offset(input.offset);
              return rows.map(serializeAdminAnnouncement);
            },
            async readAdminStats() {
              const [row] = await tx
                .select({
                  active:
                    sql<number>`count(*) filter (where ${activeAnnouncementFilter(now)})`.mapWith(
                      Number
                    ),
                  drafts:
                    sql<number>`count(*) filter (where ${announcement.isPublished} = false)`.mapWith(
                      Number
                    ),
                  pinned:
                    sql<number>`count(*) filter (where ${announcement.isPinned} = true)`.mapWith(
                      Number
                    ),
                })
                .from(announcement);
              return {
                active: row?.active ?? 0,
                drafts: row?.drafts ?? 0,
                pinned: row?.pinned ?? 0,
              };
            },
          }),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      ),
  };
}

/** 读取当前用户的完整公告分页。 */
export async function readUserAnnouncementsPage(
  userId: string,
  input: PaginationState
): Promise<UserAnnouncementListOutput> {
  const { db } = await import("@repo/database");
  return listUserAnnouncementsPage(
    userId,
    input,
    createAnnouncementListRepository(db, new Date())
  );
}

/** 读取管理公告分页及全局统计。 */
export async function readAdminAnnouncementsPage(
  input: AdminAnnouncementPageRequest
): Promise<AdminAnnouncementListOutput> {
  const { db } = await import("@repo/database");
  return listAdminAnnouncementsPage(
    input,
    createAnnouncementListRepository(db, new Date())
  );
}

/** 从 Drizzle 两种 PostgreSQL 驱动结果中提取 RETURNING 行。 */
function extractExecuteRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

/**
 * 使用单条集合 SQL 把全部活跃未读公告标记为已读。
 *
 * @param userId - 来自 Principal 的当前用户 ID。
 * @returns 本次插入或更新的公告数量。
 * @sideEffects 写入 announcement_read；不会先把全部公告 ID 拉回应用内存。
 */
export async function markAllActiveAnnouncementsReadForUser(
  userId: string
): Promise<number> {
  const { db } = await import("@repo/database");
  const readAt = new Date();
  const idPrefix = `announcement-read-${crypto.randomUUID()}-`;
  const result = await db.execute(sql`
    insert into "announcement_read" (
      "id",
      "announcement_id",
      "user_id",
      "read_at"
    )
    select
      ${idPrefix} || source."id",
      source."id",
      ${userId},
      ${readAt}
    from "announcement" as source
    left join "announcement_read" as current_read
      on current_read."announcement_id" = source."id"
      and current_read."user_id" = ${userId}
    where source."is_published" = true
      and (source."published_at" is null or source."published_at" <= ${readAt})
      and (source."expires_at" is null or source."expires_at" > ${readAt})
      and (
        current_read."id" is null
        or current_read."read_at" < source."updated_at"
      )
    on conflict ("user_id", "announcement_id") do update
      set "read_at" = excluded."read_at"
    returning "announcement_id"
  `);
  return extractExecuteRows(result).length;
}
