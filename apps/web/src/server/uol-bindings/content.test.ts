/**
 * 公开内容索引 binding 测试。
 *
 * 使用模块级内容源桩验证日期/slug 稳定排序、精确总数、越界页收敛和仅返回当前页，
 * 保持测试 DB-free 且不依赖 Fumadocs 生成目录。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const contentMocks = vi.hoisted(() => ({
  blogPosts: [] as Array<{
    info: { path: string };
    title: string;
    description: string;
    date: string | Date;
    author: string;
    tags: string[];
  }>,
  pseoPages: [] as Array<{
    slug: string;
    category: string;
    data: {
      hero: { title: string; highlight: string };
      seo: { description: string };
    };
  }>,
}));

vi.mock("@/lib/source", () => ({
  getBlogPosts: () => contentMocks.blogPosts,
}));
vi.mock("@/features/pseo/lib/pseo-data", () => ({
  getPseoPages: () => contentMocks.pseoPages,
}));

import {
  contentListBlogPosts,
  contentListPseoPages,
} from "@repo/shared/uol/operations/content";
import "./content";

const systemPrincipal = {
  type: "system" as const,
  reason: "content-binding-test",
};
const operationContext = {
  requestId: "content-binding-test",
  assertOwnership: () => undefined,
};

describe("content bindings", () => {
  beforeEach(() => {
    contentMocks.blogPosts.length = 0;
    contentMocks.pseoPages.length = 0;
  });

  /** 博客先按日期降序，再按 slug 稳定排序，并正确裁剪第二页。 */
  it("paginates sorted blog summaries", async () => {
    contentMocks.blogPosts.push(
      {
        info: { path: "en/older.mdx" },
        title: "Older",
        description: "Older summary",
        date: "2026-08-10",
        author: "A",
        tags: [],
      },
      {
        info: { path: "en/newer-b.mdx" },
        title: "Newer B",
        description: "Summary B",
        date: new Date("2026-08-13T00:00:00.000Z"),
        author: "B",
        tags: ["news"],
      },
      {
        info: { path: "en/newer-a.mdx" },
        title: "Newer A",
        description: "Summary A",
        date: "2026-08-13",
        author: "A",
        tags: [],
      }
    );
    await expect(
      contentListBlogPosts.execute(
        { locale: "en", page: 2, pageSize: 2 },
        systemPrincipal,
        operationContext
      )
    ).resolves.toMatchObject({
      records: [{ slug: "older" }],
      page: 2,
      pageSize: 2,
      totalCount: 3,
      totalPages: 2,
    });
  });

  /** 超大 PSEO 页码收敛到末页，并只返回摘要字段。 */
  it("clamps pseo pages and returns summaries", async () => {
    contentMocks.pseoPages.push(
      {
        slug: "z-page",
        category: "Z",
        data: {
          hero: { title: "Z", highlight: "Page" },
          seo: { description: "Z summary" },
        },
      },
      {
        slug: "a-page",
        category: "A",
        data: {
          hero: { title: "A", highlight: "Page" },
          seo: { description: "A summary" },
        },
      }
    );
    await expect(
      contentListPseoPages.execute(
        { locale: "zh", page: 99, pageSize: 1 },
        systemPrincipal,
        operationContext
      )
    ).resolves.toEqual({
      records: [
        {
          slug: "z-page",
          category: "Z",
          title: "Z Page",
          description: "Z summary",
        },
      ],
      page: 2,
      pageSize: 1,
      totalCount: 2,
      totalPages: 2,
    });
  });
});
