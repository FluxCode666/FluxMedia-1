/**
 * sitemap 模型广场发现入口测试。
 *
 * 使用方是 Vitest；隔离内容集合后验证静态路径为中英文各生成一条 `/models` URL。
 */
import { siteConfig } from "@repo/shared/config";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/pseo/lib/pseo-data", () => ({
  getAllPseoParams: () => [],
}));
vi.mock("@/lib/source", () => ({
  getAllBlogSlugs: () => [],
  getAllLegalSlugs: () => [],
}));

import sitemap from "./sitemap";

describe("sitemap", () => {
  it("为 en 与 zh 发布模型广场 URL", () => {
    const urls = sitemap().map((entry) => entry.url);

    expect(urls).toContain(`${siteConfig.url}/en/models`);
    expect(urls).toContain(`${siteConfig.url}/zh/models`);
    expect(urls.filter((url) => url.endsWith("/models"))).toHaveLength(2);
  });
});
