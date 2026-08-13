/**
 * UOL Operations - content 域。
 *
 * 职责：定义博客与 PSEO 完整公开索引的分页契约。operation 只返回列表卡片所需摘要，
 * 详情 FAQ、相关推荐与搜索下拉候选不在该域中，避免把排除项误扩成分页结果。
 */

import { z } from "zod";
import { createOffsetPaginationOutputSchema } from "../../pagination/contracts";
import { defineOperation } from "../registry";

/** 公开内容索引共用输入；locale 必须是站点已支持的明确值。 */
const contentListInputSchema = z
  .object({
    locale: z.enum(["en", "zh"]),
    page: z.number().int().positive().safe().default(1),
    pageSize: z.number().int().min(1).max(50).default(20),
  })
  .strict();

/** 博客索引卡片 DTO，不暴露 MDX body、文件绝对路径或详情组件。 */
export const blogPostSummarySchema = z
  .object({
    slug: z.string().min(1).max(240),
    title: z.string().min(1).max(500),
    description: z.string().max(2_000),
    date: z.string().min(1).max(80),
    author: z.string().min(1).max(240),
    tags: z.array(z.string().min(1).max(100)).max(50),
  })
  .strict();

/** PSEO 索引卡片 DTO；详情数据继续由详情路由按 slug 读取。 */
export const pseoPageSummarySchema = z
  .object({
    slug: z.string().min(1).max(240),
    category: z.string().min(1).max(240),
    title: z.string().min(1).max(1_000),
    description: z.string().max(2_000),
  })
  .strict();

/** 博客分页输出。 */
export const blogPostListOutputSchema = createOffsetPaginationOutputSchema(
  blogPostSummarySchema
);

/** PSEO 分页输出。 */
export const pseoPageListOutputSchema = createOffsetPaginationOutputSchema(
  pseoPageSummarySchema
);

export type BlogPostSummary = z.infer<typeof blogPostSummarySchema>;
export type BlogPostListOutput = z.infer<typeof blogPostListOutputSchema>;
export type PseoPageSummary = z.infer<typeof pseoPageSummarySchema>;
export type PseoPageListOutput = z.infer<typeof pseoPageListOutputSchema>;

/** 公开博客索引 offset 分页；匿名页面由 Web 传输层构造 system Principal。 */
export const contentListBlogPosts = defineOperation({
  name: "content.listBlogPosts",
  domain: "content",
  title: "获取博客文章索引",
  description:
    "按语言和稳定发布日期读取博客文章摘要，返回精确总条数和随机访问页码。",
  input: contentListInputSchema,
  output: blogPostListOutputSchema,
  access: { kind: "public" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: content.listBlogPosts");
  },
});

/** 公开 PSEO 完整索引 offset 分页；详情 related/FAQ 保持原读取方式。 */
export const contentListPseoPages = defineOperation({
  name: "content.listPseoPages",
  domain: "content",
  title: "获取 PSEO 页面索引",
  description:
    "按语言和稳定 slug 读取 PSEO 模板摘要，返回精确总条数和随机访问页码。",
  input: contentListInputSchema,
  output: pseoPageListOutputSchema,
  access: { kind: "public" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: content.listPseoPages");
  },
});
