/**
 * 公开内容索引页面的数据装配边界。
 *
 * 使用方：博客与 PSEO Server Components。匿名请求构造 system Principal 调用公开 UOL，
 * URL 只负责提供已经白名单解析的页码和页大小；失败交给页面错误边界。
 */

import { invokeOperation } from "@repo/shared/uol";
import type {
  BlogPostListOutput,
  PseoPageListOutput,
} from "@repo/shared/uol/operations/content";
import { ensureUolInitialized } from "@/server/uol-init";

/** 读取公开博客索引分页。 */
export async function loadBlogIndexPageData(input: {
  locale: "en" | "zh";
  page: number;
  pageSize: number;
}): Promise<BlogPostListOutput> {
  await ensureUolInitialized();
  return invokeOperation<BlogPostListOutput>("content.listBlogPosts", input, {
    type: "system",
    reason: "public-blog-index-page",
  });
}

/** 读取公开 PSEO 索引分页。 */
export async function loadPseoIndexPageData(input: {
  locale: "en" | "zh";
  page: number;
  pageSize: number;
}): Promise<PseoPageListOutput> {
  await ensureUolInitialized();
  return invokeOperation<PseoPageListOutput>("content.listPseoPages", input, {
    type: "system",
    reason: "public-pseo-index-page",
  });
}
