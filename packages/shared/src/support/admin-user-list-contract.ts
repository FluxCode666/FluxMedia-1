/**
 * 管理用户列表分页契约。
 *
 * 使用方：user.list UOL operation、数据库读取服务和管理用户 Server Action。
 * 只允许产品确认的 10/20/50 页大小，并为 URL 输入提供稳定默认值。
 */
import { z } from "zod";

export const adminUserStatusSchema = z.enum([
  "all",
  "active",
  "banned",
  "unverified",
]);
export const adminUserCreditsStatusSchema = z.enum(["all", "active", "frozen"]);

export const adminUserListInputSchema = z.object({
  query: z.string().trim().max(320).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.union([z.literal(10), z.literal(20), z.literal(50)]).default(20),
  status: adminUserStatusSchema.default("all"),
  creditsStatus: adminUserCreditsStatusSchema.default("all"),
});

const adminUserListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  role: z.enum(["user", "observer_admin", "admin", "super_admin"]),
  banned: z.boolean(),
  bannedReason: z.string().nullable(),
  emailVerified: z.boolean(),
  imageGenerationConcurrencyOverride: z.number().int().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  creditsBalance: z.number(),
  creditsTotalEarned: z.number(),
  creditsTotalSpent: z.number(),
  creditsStatus: z.enum(["active", "frozen"]),
  generationCount: z.number().int().nonnegative(),
  failedGenerationCount: z.number().int().nonnegative(),
  apiKeyCount: z.number().int().nonnegative(),
  activeApiKeyCount: z.number().int().nonnegative(),
});

export const adminUserListOutputSchema = z.object({
  users: z.array(adminUserListRowSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalCount: z.number().int().nonnegative(),
    totalPages: z.number().int().positive(),
  }),
  stats: z.object({
    totalUsers: z.number().int().nonnegative(),
    admins: z.number().int().nonnegative(),
    banned: z.number().int().nonnegative(),
  }),
});

export type AdminUserListInput = z.output<typeof adminUserListInputSchema>;
export type AdminUserListOutput = z.output<typeof adminUserListOutputSchema>;
