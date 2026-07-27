/**
 * 模型广场封面引用安全边界测试。
 *
 * 使用方是管理读取、公开目录和后续公共存储路由；测试锁定 bucket 单段约束、内容寻址
 * key、类别隔离与第一方 URL，防止数据库脏值经路径规范化越过目标路由。
 */
import { describe, expect, it } from "vitest";

import {
  assertModelMarketplaceCoverReference,
  buildModelMarketplaceCoverUrl,
  parseModelMarketplaceAssetBucketName,
} from "./asset-reference";

const CONFIG_HASH = "a".repeat(64);
const CONTENT_HASH = "b".repeat(64);
const IMAGE_KEY = `image/${CONFIG_HASH}/${CONTENT_HASH}.webp`;

describe("parseModelMarketplaceAssetBucketName", () => {
  it("返回去空白后的单段 bucket", () => {
    expect(parseModelMarketplaceAssetBucketName(" model-marketplace ")).toBe(
      "model-marketplace"
    );
  });

  it.each([
    undefined,
    "",
    ".",
    "..",
    "../generations",
    "models/assets",
    "models\\assets",
    "models%2Fassets",
    "含中文",
  ])("拒绝无法安全放入 URL path segment 的 bucket：%s", (value) => {
    expect(() => parseModelMarketplaceAssetBucketName(value)).toThrow(
      /存储桶名称无效/
    );
  });
});

describe("模型广场内容寻址封面引用", () => {
  it("验证类别与两个小写 SHA-256，并构造稳定第一方 URL", () => {
    const cover = { bucket: "model-marketplace", key: IMAGE_KEY };

    expect(
      assertModelMarketplaceCoverReference("image", cover, "model-marketplace")
    ).toBe(cover);
    expect(
      buildModelMarketplaceCoverUrl("image", cover, "model-marketplace")
    ).toBe(`/api/storage/model-marketplace/${IMAGE_KEY}`);
  });

  it.each([
    ["跨 bucket", "image", "avatars", IMAGE_KEY],
    ["类别串用", "video", "model-marketplace", IMAGE_KEY],
    ["目录穿越", "image", "model-marketplace", "image/../cover.webp"],
    ["非哈希键", "image", "model-marketplace", "image/custom/cover.webp"],
    [
      "大写哈希",
      "image",
      "model-marketplace",
      `image/${CONFIG_HASH.toUpperCase()}/${CONTENT_HASH}.webp`,
    ],
    ["额外层级", "image", "model-marketplace", `${IMAGE_KEY}/extra`],
  ] as const)("拒绝%s", (_label, category, bucket, key) => {
    expect(() =>
      buildModelMarketplaceCoverUrl(
        category,
        { bucket, key },
        "model-marketplace"
      )
    ).toThrow();
  });
});
