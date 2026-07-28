/**
 * 网站品牌资产引用边界测试。
 *
 * 覆盖默认和自定义 bucket、严格内容寻址 key、跨 bucket 拒绝及第一方 URL 构造。
 * 本测试为纯函数测试，不触达数据库、对象存储或系统设置。
 */
import { describe, expect, it } from "vitest";

import {
  assertSiteLogoAssetReference,
  buildSiteLogoAssetUrl,
  DEFAULT_SITE_ASSETS_BUCKET_NAME,
  parseSiteAssetsBucketName,
} from "./asset-reference";

const LOGO_KEY = `logo/${"a".repeat(64)}.png`;

describe("网站品牌资产引用", () => {
  it("设置缺失时使用默认 bucket，并规范化合法自定义名称", () => {
    expect(parseSiteAssetsBucketName(undefined)).toBe(
      DEFAULT_SITE_ASSETS_BUCKET_NAME
    );
    expect(parseSiteAssetsBucketName(null)).toBe(
      DEFAULT_SITE_ASSETS_BUCKET_NAME
    );
    expect(parseSiteAssetsBucketName("  brand.assets_1  ")).toBe(
      "brand.assets_1"
    );
  });

  it.each([
    "",
    "   ",
    ".",
    "..",
    "../assets",
    "site/assets",
    "site%2Fassets",
  ])("拒绝非法 bucket：%s", (bucket) => {
    expect(() => parseSiteAssetsBucketName(bucket)).toThrow(
      "网站资产存储桶名称无效"
    );
  });

  it("接受当前专用 bucket 下的严格小写 SHA-256 key", () => {
    const reference = { bucket: "site-assets", key: LOGO_KEY };

    expect(assertSiteLogoAssetReference(reference, "site-assets")).toEqual(
      reference
    );
  });

  it.each([
    `logo/${"A".repeat(64)}.png`,
    `logo/${"a".repeat(63)}.png`,
    `logo/${"a".repeat(65)}.png`,
    `logo/${"a".repeat(64)}.webp`,
    `icons/${"a".repeat(64)}.png`,
    `logo/../${"a".repeat(64)}.png`,
    `logo/${"g".repeat(64)}.png`,
  ])("拒绝非规范 Logo key：%s", (key) => {
    expect(() =>
      assertSiteLogoAssetReference(
        { bucket: "site-assets", key },
        "site-assets"
      )
    ).toThrow("网站 Logo 对象 key 不符合内容寻址契约");
  });

  it("拒绝跨 bucket 引用", () => {
    expect(() =>
      assertSiteLogoAssetReference(
        { bucket: "avatars", key: LOGO_KEY },
        "site-assets"
      )
    ).toThrow("网站 Logo 引用了非法存储桶");
  });

  it("只为合法引用构造第一方读取 URL", () => {
    expect(
      buildSiteLogoAssetUrl(
        { bucket: "brand.assets", key: LOGO_KEY },
        "brand.assets"
      )
    ).toBe(`/api/storage/brand.assets/${LOGO_KEY}`);
  });
});
