/**
 * content UOL 分页契约测试。
 *
 * 覆盖公开权限、human-only Agent 边界、严格 locale/page/pageSize 和两种安全摘要输出，
 * 防止详情正文、FAQ 或推荐数据误穿过完整索引 operation。
 */

import { describe, expect, it } from "vitest";
import {
  blogPostListOutputSchema,
  contentListBlogPosts,
  contentListPseoPages,
  pseoPageListOutputSchema,
} from "./content";

describe("content operations", () => {
  /** 两个公开索引均只允许人工页面消费，不扩大 MCP 工具集合。 */
  it("registers public human-only read operations", () => {
    for (const operation of [contentListBlogPosts, contentListPseoPages]) {
      expect(operation).toMatchObject({
        domain: "content",
        access: { kind: "public" },
        agentExposure: "human-only",
        readOnly: true,
        destructive: false,
      });
    }
  });

  /** 输入不接受未知语言、过大页大小或任意附加身份字段。 */
  it("validates strict list inputs", () => {
    expect(
      contentListBlogPosts.input.parse({ locale: "zh", page: 2, pageSize: 20 })
    ).toEqual({ locale: "zh", page: 2, pageSize: 20 });
    expect(contentListBlogPosts.input.safeParse({ locale: "fr" }).success).toBe(
      false
    );
    expect(
      contentListBlogPosts.input.safeParse({ locale: "en", pageSize: 51 })
        .success
    ).toBe(false);
    expect(
      contentListBlogPosts.input.safeParse({ locale: "en", userId: "x" })
        .success
    ).toBe(false);
  });

  /** 博客输出只保留卡片摘要和共享分页信封。 */
  it("keeps blog list output summary-only", () => {
    const output = {
      records: [
        {
          slug: "hello",
          title: "Hello",
          description: "Summary",
          date: "2026-08-13",
          author: "FluxMedia",
          tags: ["news"],
        },
      ],
      page: 1,
      pageSize: 20,
      totalCount: 1,
      totalPages: 1,
    };
    expect(blogPostListOutputSchema.parse(output)).toEqual(output);
    expect(
      blogPostListOutputSchema.safeParse({
        ...output,
        records: [{ ...output.records[0], body: "private mdx" }],
      }).success
    ).toBe(false);
  });

  /** PSEO 输出不得携带 FAQ、related 或完整 locale data。 */
  it("keeps pseo list output summary-only", () => {
    const output = {
      records: [
        {
          slug: "image-generator",
          category: "AI",
          title: "Image generator",
          description: "Summary",
        },
      ],
      page: 1,
      pageSize: 20,
      totalCount: 1,
      totalPages: 1,
    };
    expect(pseoPageListOutputSchema.parse(output)).toEqual(output);
    expect(
      pseoPageListOutputSchema.safeParse({
        ...output,
        records: [{ ...output.records[0], faq: [] }],
      }).success
    ).toBe(false);
  });
});
