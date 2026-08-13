/**
 * 公告列表的统一分页契约。
 *
 * 使用方：公告领域服务、support UOL operation 与 Web 页面。用户和管理员列表
 * 共用 offset 分页信封；管理员额外返回不受当前页和发布筛选影响的全局统计。
 */
import { z } from "zod";

import { createOffsetPaginationOutputSchema } from "../pagination/contracts";

export const announcementListPageSizes = [10, 20, 50] as const;
export const adminAnnouncementPublishedFilters = [
  "all",
  "published",
  "unpublished",
] as const;

const pageSchema = z.number().int().positive().safe();
const pageSizeSchema = z.union([z.literal(10), z.literal(20), z.literal(50)]);

/** 当前用户公告完整页的输入契约。 */
export const userAnnouncementListInputSchema = z
  .object({
    page: pageSchema.default(1),
    pageSize: pageSizeSchema.default(20),
  })
  .strict();

/** 管理公告完整页的输入契约。 */
export const adminAnnouncementListInputSchema = z
  .object({
    page: pageSchema.default(1),
    pageSize: pageSizeSchema.default(20),
    published: z.enum(adminAnnouncementPublishedFilters).default("all"),
  })
  .strict();

/** 用户公告卡片 DTO；日期均为可跨传输序列化的 ISO 字符串。 */
export const userAnnouncementListRecordSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    content: z.string(),
    severity: z.string(),
    isPinned: z.boolean(),
    priority: z.number().int(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    isRead: z.boolean(),
  })
  .strict();

/** 管理公告卡片 DTO；包含编辑和审计展示所需的完整安全字段。 */
export const adminAnnouncementListRecordSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    content: z.string(),
    severity: z.string(),
    isPublished: z.boolean(),
    isPinned: z.boolean(),
    priority: z.number().int(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    createdByUserId: z.string().nullable(),
    updatedByUserId: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const userAnnouncementListOutputSchema =
  createOffsetPaginationOutputSchema(userAnnouncementListRecordSchema);

export const adminAnnouncementListStatsSchema = z
  .object({
    active: z.number().int().nonnegative().safe(),
    drafts: z.number().int().nonnegative().safe(),
    pinned: z.number().int().nonnegative().safe(),
  })
  .strict();

export const adminAnnouncementListOutputSchema =
  createOffsetPaginationOutputSchema(adminAnnouncementListRecordSchema).extend({
    stats: adminAnnouncementListStatsSchema,
  });

export type UserAnnouncementListInput = z.output<
  typeof userAnnouncementListInputSchema
>;
export type AdminAnnouncementListInput = z.output<
  typeof adminAnnouncementListInputSchema
>;
export type UserAnnouncementListRecord = z.output<
  typeof userAnnouncementListRecordSchema
>;
export type AdminAnnouncementItem = z.output<
  typeof adminAnnouncementListRecordSchema
>;
export type UserAnnouncementListOutput = z.output<
  typeof userAnnouncementListOutputSchema
>;
export type AdminAnnouncementListOutput = z.output<
  typeof adminAnnouncementListOutputSchema
>;
export type AdminAnnouncementPublishedFilter =
  (typeof adminAnnouncementPublishedFilters)[number];
