/**
 * 客服工单与消息分页契约。
 *
 * 使用方：support UOL operations、数据库读取服务和控制台工单页面。
 * 只允许产品确认的 10/20/50 页大小，并让列表筛选与消息 namespace 共用
 * 同一套精确 offset 分页语义。
 */
import { z } from "zod";

import { createOffsetPaginationOutputSchema } from "../pagination/contracts";

export const ticketStatusFilterSchema = z.enum([
  "all",
  "open",
  "in_progress",
  "resolved",
  "closed",
]);

const ticketPageSizeSchema = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(50),
]);

export const ticketListInputSchema = z
  .object({
    page: z.number().int().positive().default(1),
    pageSize: ticketPageSizeSchema.default(20),
    status: ticketStatusFilterSchema.default("all"),
    search: z.string().trim().max(200).default(""),
  })
  .strict();

export const ticketListRecordSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    subject: z.string(),
    category: z.enum(["billing", "technical", "bug", "feature", "other"]),
    priority: z.enum(["low", "medium", "high"]),
    status: ticketStatusFilterSchema.exclude(["all"]),
    unread: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
    userName: z.string().nullable(),
    userEmail: z.string().nullable(),
  })
  .strict();

export const ticketListOutputSchema = createOffsetPaginationOutputSchema(
  ticketListRecordSchema
);

export const ticketMessageListInputSchema = z
  .object({
    ticketId: z.string().min(1),
    page: z.number().int().positive().default(1),
    pageSize: ticketPageSizeSchema.default(20),
  })
  .strict();

const ticketDetailSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    subject: z.string(),
    category: z.enum(["billing", "technical", "bug", "feature", "other"]),
    priority: z.enum(["low", "medium", "high"]),
    status: ticketStatusFilterSchema.exclude(["all"]),
    userLastSeenAt: z.date(),
    lastAdminActivityAt: z.date().nullable(),
    adminLastSeenAt: z.date().nullable(),
    lastUserActivityAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

const ticketMessageRecordSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    isAdminResponse: z.boolean(),
    createdAt: z.date(),
    user: z
      .object({
        id: z.string().nullable(),
        name: z.string().nullable(),
        image: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const ticketMessageListOutputSchema = z
  .object({
    ticket: ticketDetailSchema,
    ticketUser: z
      .object({
        id: z.string().nullable(),
        name: z.string().nullable(),
        email: z.string().nullable(),
        image: z.string().nullable(),
      })
      .strict()
      .nullable(),
    messages: createOffsetPaginationOutputSchema(ticketMessageRecordSchema),
  })
  .strict();

export const markTicketSeenInputSchema = z
  .object({ ticketId: z.string().min(1) })
  .strict();

export const markTicketSeenOutputSchema = z
  .object({ seenAt: z.date() })
  .strict();

export type TicketListInput = z.output<typeof ticketListInputSchema>;
export type TicketListOutput = z.output<typeof ticketListOutputSchema>;
export type TicketMessageListInput = z.output<
  typeof ticketMessageListInputSchema
>;
export type TicketMessageListOutput = z.output<
  typeof ticketMessageListOutputSchema
>;
export type MarkTicketSeenOutput = z.output<typeof markTicketSeenOutputSchema>;
