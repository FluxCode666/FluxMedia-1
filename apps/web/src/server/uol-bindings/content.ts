/**
 * 博客与 PSEO 公开索引 UOL late binding。
 *
 * 职责：读取既有内容源，将完整集合在服务端稳定排序后执行精确 offset 分页。详情页、
 * FAQ、相关推荐与搜索候选仍走原有有界读取，不经过本列表 binding。
 */

import { resolvePaginationState } from "@repo/shared/pagination/state";
import { bindOperationExecute } from "@repo/shared/uol";
import {
  type BlogPostListOutput,
  type BlogPostSummary,
  blogPostListOutputSchema,
  contentListBlogPosts,
  contentListPseoPages,
  type PseoPageListOutput,
  type PseoPageSummary,
  pseoPageListOutputSchema,
} from "@repo/shared/uol/operations/content";
import { getPseoPages } from "@/features/pseo/lib/pseo-data";
import { getBlogPosts } from "@/lib/source";

/** Fumadocs 生成模块对索引 binding 暴露的最小博客形状。 */
interface BlogSourcePost {
  info: { path: string };
  title: string;
  description: string;
  date: string | Date;
  author: string;
  tags: string[];
}

/** 从 Fumadocs 内容项路径提取稳定 slug。 */
function getBlogSlug(path: string): string {
  const pathParts = path.split("/");
  const fileName = pathParts.at(-1) ?? "";
  return fileName.replace(/\.mdx$/, "");
}

/** 把博客日期规范化为列表可序列化的稳定文本。 */
function formatBlogDate(value: string | Date): string {
  return typeof value === "string"
    ? value
    : (value.toISOString().split("T")[0] ?? "");
}

/** 用精确数组长度解析越界页，并只截取规范化当前页。 */
function paginateRecords<Record>(
  records: Record[],
  input: { page: number; pageSize: number }
) {
  const pagination = resolvePaginationState(input, records.length);
  const start = (pagination.page - 1) * pagination.pageSize;
  return {
    records: records.slice(start, start + pagination.pageSize),
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalCount: pagination.totalCount,
    totalPages: pagination.totalPages,
  };
}

/** 博客索引按日期降序、slug 升序稳定分页。 */
bindOperationExecute(contentListBlogPosts, async (input) => {
  const sourcePosts = getBlogPosts(input.locale) as BlogSourcePost[];
  const records: BlogPostSummary[] = sourcePosts
    .map((post) => ({
      slug: getBlogSlug(post.info.path),
      title: post.title,
      description: post.description,
      date: formatBlogDate(post.date),
      author: post.author,
      tags: post.tags,
    }))
    .sort((left, right) => {
      const byDate = Date.parse(right.date) - Date.parse(left.date);
      return byDate === 0 ? left.slug.localeCompare(right.slug) : byDate;
    });
  return blogPostListOutputSchema.parse(
    paginateRecords(records, input)
  ) satisfies BlogPostListOutput;
});

/** PSEO 索引按 slug 稳定分页，只返回列表卡片摘要。 */
bindOperationExecute(contentListPseoPages, async (input) => {
  const records: PseoPageSummary[] = getPseoPages(input.locale)
    .map((page) => ({
      slug: page.slug,
      category: page.category,
      title: `${page.data.hero.title} ${page.data.hero.highlight}`.trim(),
      description: page.data.seo.description,
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
  return pseoPageListOutputSchema.parse(
    paginateRecords(records, input)
  ) satisfies PseoPageListOutput;
});
