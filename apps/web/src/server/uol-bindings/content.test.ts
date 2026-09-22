import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestGoJson: vi.fn() }));
vi.mock("@/server/go-backend-client", () => ({
  requestGoJson: mocks.requestGoJson,
}));

import {
  contentListBlogPosts,
  contentListPseoPages,
} from "@repo/shared/uol/operations/content";
import "./content";

const principal = { type: "system" as const, reason: "content-binding-test" };
const context = {
  requestId: "content-binding-test",
  assertOwnership: () => undefined,
};
const blogRecord = {
  slug: "article",
  title: "Article",
  description: "Summary",
  date: "2026-09-14",
  author: "Team",
  tags: [],
};
const pseoRecord = {
  slug: "template",
  category: "image",
  title: "Template",
  description: "Summary",
};
const page = { page: 2, pageSize: 1, totalCount: 2, totalPages: 2 };

describe("content Go bindings", () => {
  beforeEach(() => {
    mocks.requestGoJson.mockReset();
  });

  it("passes blog locale and pagination to Go and preserves the validated page", async () => {
    const output = { ...page, records: [blogRecord] };
    mocks.requestGoJson.mockResolvedValue(output);
    await expect(
      contentListBlogPosts.execute(
        { locale: "en", page: 2, pageSize: 1 },
        principal,
        context
      )
    ).resolves.toEqual(output);
    expect(mocks.requestGoJson).toHaveBeenCalledWith(
      "/api/content/blog?locale=en&page=2&pageSize=1"
    );
  });

  it("passes PSEO locale and requested page while accepting the backend clamped page", async () => {
    const output = { ...page, records: [pseoRecord] };
    mocks.requestGoJson.mockResolvedValue(output);
    await expect(
      contentListPseoPages.execute(
        { locale: "zh", page: 99, pageSize: 1 },
        principal,
        context
      )
    ).resolves.toEqual(output);
    expect(mocks.requestGoJson).toHaveBeenCalledWith(
      "/api/content/pseo?locale=zh&page=99&pageSize=1"
    );
  });

  it.each([
    { ...blogRecord, tags: null },
    { ...blogRecord, Slug: "internal" },
    { ...blogRecord, body: "private MDX body" },
  ])("rejects invalid or extra blog DTO fields", async (record) => {
    mocks.requestGoJson.mockResolvedValue({ ...page, records: [record] });
    await expect(
      contentListBlogPosts.execute(
        { locale: "en", page: 2, pageSize: 1 },
        principal,
        context
      )
    ).rejects.toThrow();
  });

  it("rejects PSEO implementation fields", async () => {
    mocks.requestGoJson.mockResolvedValue({
      ...page,
      records: [{ ...pseoRecord, locales: {} }],
    });
    await expect(
      contentListPseoPages.execute(
        { locale: "zh", page: 2, pageSize: 1 },
        principal,
        context
      )
    ).rejects.toThrow();
  });

  it("propagates backend failures instead of presenting an empty index", async () => {
    const failure = new Error("Go content unavailable");
    mocks.requestGoJson.mockRejectedValue(failure);
    await expect(
      contentListBlogPosts.execute(
        { locale: "en", page: 2, pageSize: 1 },
        principal,
        context
      )
    ).rejects.toBe(failure);
    await expect(
      contentListPseoPages.execute(
        { locale: "zh", page: 2, pageSize: 1 },
        principal,
        context
      )
    ).rejects.toBe(failure);
  });
});
