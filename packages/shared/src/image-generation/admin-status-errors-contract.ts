/**
 * 管理状态页历史错误分页契约。
 *
 * 使用方：image.listAdminStatusErrors UOL operation、Web 数据库 binding 与状态页。
 * 输入只接收绝对时间边界和 10/20/50 页大小，筛选文案与时区留在传输层。
 */
import { z } from "zod";

export const adminStatusErrorListInputSchema = z.object({
  fromDate: z.date().nullable().default(null),
  toDate: z.date().nullable().default(null),
  page: z.number().int().positive().default(1),
  pageSize: z.union([z.literal(10), z.literal(20), z.literal(50)]).default(20),
});

export const adminStatusErrorListOutputSchema = z.object({
  records: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      userEmail: z.string().nullable(),
      userName: z.string().nullable(),
      prompt: z.string(),
      model: z.string(),
      size: z.string(),
      creditsConsumed: z.number(),
      error: z.string().nullable(),
      createdAt: z.date(),
      completedAt: z.date().nullable(),
      category: z.enum(["platform", "moderation", "user_request"]),
    })
  ),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
});

export type AdminStatusErrorListInput = z.output<
  typeof adminStatusErrorListInputSchema
>;
export type AdminStatusErrorListOutput = z.output<
  typeof adminStatusErrorListOutputSchema
>;
