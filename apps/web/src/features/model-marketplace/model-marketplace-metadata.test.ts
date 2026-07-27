/**
 * 模型广场 Metadata 纯函数测试。
 *
 * 使用方是 Vitest；锁定中英文 canonical、alternates 和本地化搜索摘要。
 */
import { siteConfig } from "@repo/shared/config";
import { describe, expect, it } from "vitest";

import {
  buildModelMarketplaceMetadata,
  normalizeModelMarketplaceMetadataLocale,
} from "./model-marketplace-metadata";

describe("buildModelMarketplaceMetadata", () => {
  it.each(["en", "zh"] as const)("为 %s 输出当前语言 canonical", (locale) => {
    const metadata = buildModelMarketplaceMetadata(locale);

    expect(metadata.alternates?.canonical).toBe(
      `${siteConfig.url}/${locale}/models`
    );
    expect(metadata.alternates?.languages).toEqual({
      en: `${siteConfig.url}/en/models`,
      zh: `${siteConfig.url}/zh/models`,
    });
    expect(metadata.openGraph?.url).toBe(`${siteConfig.url}/${locale}/models`);
  });

  it("输出分别面向中文与英文搜索的模型广场摘要", () => {
    const zh = buildModelMarketplaceMetadata("zh");
    const en = buildModelMarketplaceMetadata("en");

    expect(String(zh.title)).toContain("模型广场");
    expect(zh.description).toContain("图像与视频");
    expect(String(en.title)).toContain("Model Marketplace");
    expect(en.description).toContain("image and video");
  });

  it("未知 locale 安全回退英文", () => {
    expect(normalizeModelMarketplaceMetadataLocale("zh")).toBe("zh");
    expect(normalizeModelMarketplaceMetadataLocale("fr")).toBe("en");
  });
});
