/**
 * 模型广场内置资产契约测试。
 *
 * 使用方是公开目录和模型卡片；测试保证全部 iconKey 有本地映射、默认封面是固定 3:2
 * WebP，并拒绝品牌 SVG 携带脚本、事件处理器、外链资源或运行时文字。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  modelMarketplaceIconKeySchema,
  modelMarketplacePublicCategorySchema,
} from "@repo/shared/model-marketplace";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  getDefaultModelMarketplaceCoverPath,
  getModelMarketplaceIconPath,
  MODEL_MARKETPLACE_DEFAULT_COVER_PATHS,
  MODEL_MARKETPLACE_ICON_PATHS,
} from "./assets";

/**
 * 将公开根路径解析到当前 Web 应用的 public 目录。
 *
 * @param publicPath - 以斜杠开头的第一方静态资源路径。
 * @returns 可供 Node.js 读取的绝对文件路径。
 * @sideEffects 无。
 * @failure 输入不是第一方根路径时抛出测试错误，避免意外读取工作区外文件。
 */
function resolvePublicAssetPath(publicPath: string): string {
  if (!publicPath.startsWith("/") || publicPath.startsWith("//")) {
    throw new Error("模型广场资产必须使用第一方根路径");
  }
  return path.join(process.cwd(), "public", publicPath.slice(1));
}

describe("模型广场资产映射", () => {
  it("完整覆盖共享契约中的全部 iconKey", () => {
    const iconKeys = modelMarketplaceIconKeySchema.options;

    expect(Object.keys(MODEL_MARKETPLACE_ICON_PATHS).sort()).toEqual(
      [...iconKeys].sort()
    );
    for (const iconKey of iconKeys) {
      const assetPath = getModelMarketplaceIconPath(iconKey);
      expect(assetPath).toBe(MODEL_MARKETPLACE_ICON_PATHS[iconKey]);
      expect(assetPath).toMatch(
        new RegExp(`^/model-marketplace/brands/${iconKey}\\.svg$`)
      );
    }
  });

  it("完整覆盖图像与视频默认封面并保持唯一公开路径", () => {
    const categories = modelMarketplacePublicCategorySchema.options;

    expect(Object.keys(MODEL_MARKETPLACE_DEFAULT_COVER_PATHS).sort()).toEqual(
      [...categories].sort()
    );
    expect(
      new Set(Object.values(MODEL_MARKETPLACE_DEFAULT_COVER_PATHS)).size
    ).toBe(categories.length);
    for (const category of categories) {
      expect(getDefaultModelMarketplaceCoverPath(category)).toBe(
        MODEL_MARKETPLACE_DEFAULT_COVER_PATHS[category]
      );
    }
  });
});

describe("模型广场默认封面", () => {
  it.each(
    modelMarketplacePublicCategorySchema.options
  )("%s 封面是 1200×800 的 3:2 WebP", async (category) => {
    const assetPath = getDefaultModelMarketplaceCoverPath(category);
    const metadata = await sharp(resolvePublicAssetPath(assetPath), {
      failOn: "warning",
    }).metadata();

    expect(metadata).toMatchObject({
      format: "webp",
      width: 1200,
      height: 800,
    });
    expect(metadata.pages ?? 1).toBe(1);
    expect((metadata.width ?? 0) / (metadata.height ?? 1)).toBe(3 / 2);
  });
});

describe("模型广场品牌兼容标识", () => {
  it.each(
    modelMarketplaceIconKeySchema.options
  )("%s SVG 仅包含本地静态几何", async (iconKey) => {
    const svg = await readFile(
      resolvePublicAssetPath(getModelMarketplaceIconPath(iconKey)),
      "utf8"
    );

    expect(svg).toMatch(/<svg\b/);
    expect(svg).not.toMatch(/<script\b/i);
    expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
    expect(svg).not.toMatch(/\b(?:href|src)\s*=/i);
    expect(svg).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
    expect(svg).not.toMatch(/<text\b/i);
  });
});
