/**
 * 博客与 PSEO 公开索引 UOL late binding。
 *
 * 职责：将公开索引请求转发到 Go 内容接口并校验严格分页 DTO。详情页、FAQ、
 * 相关推荐与搜索候选仍走原有有界读取，不经过本列表 binding。
 */

import { bindOperationExecute } from "@repo/shared/uol";
import {
  type BlogPostListOutput,
  blogPostListOutputSchema,
  contentListBlogPosts,
  contentListPseoPages,
  type PseoPageListOutput,
  pseoPageListOutputSchema,
} from "@repo/shared/uol/operations/content";
import { requestGoJson } from "@/server/go-backend-client";

/** 博客索引按日期降序、slug 升序稳定分页。 */
bindOperationExecute(contentListBlogPosts, async (input) => {
  const query = new URLSearchParams({
    locale: input.locale,
    page: String(input.page),
    pageSize: String(input.pageSize),
  });
  const result = await requestGoJson<BlogPostListOutput>(
    `/api/content/blog?${query.toString()}`
  );
  return blogPostListOutputSchema.parse(result) satisfies BlogPostListOutput;
});

/** PSEO 索引按 slug 稳定分页，只返回列表卡片摘要。 */
bindOperationExecute(contentListPseoPages, async (input) => {
  const query = new URLSearchParams({
    locale: input.locale,
    page: String(input.page),
    pageSize: String(input.pageSize),
  });
  const result = await requestGoJson<PseoPageListOutput>(
    `/api/content/pseo?${query.toString()}`
  );
  return pseoPageListOutputSchema.parse(result) satisfies PseoPageListOutput;
});
