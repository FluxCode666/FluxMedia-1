/**
 * 统一存储桶与生成产物对象键契约的 DB-free 单测。
 *
 * 使用方：Vitest；防止公开资产与用户生成内容混桶，以及图片/视频目录结构回退。
 */

import { describe, expect, it } from "vitest";

import {
  buildGeneratedImageStorageKey,
  buildGeneratedVideoStorageKey,
  parseRuntimeStorageBucketConfig,
  StorageBucketConfigError,
} from "./bucket-config";

describe("runtime storage bucket config", () => {
  it("缺少设置时使用统一系统资产桶和统一生成内容桶", () => {
    expect(parseRuntimeStorageBucketConfig(undefined, undefined)).toEqual({
      systemAssets: "system",
      generations: "generations",
    });
  });

  it("允许自定义两个隔离的运行时桶", () => {
    expect(
      parseRuntimeStorageBucketConfig(" system-assets ", " user-outputs ")
    ).toEqual({
      systemAssets: "system-assets",
      generations: "user-outputs",
    });
  });

  it.each([
    ["system", "system"],
    ["_avatars", "generations"],
    ["system", "../generations"],
    ["", "generations"],
  ])("拒绝非法或未隔离的桶配置", (systemAssets, generations) => {
    expect(() =>
      parseRuntimeStorageBucketConfig(systemAssets, generations)
    ).toThrow(StorageBucketConfigError);
  });
});

describe("generated output storage keys", () => {
  it("把新图片和视频写入用户自己的分类目录", () => {
    expect(buildGeneratedImageStorageKey("user-1", "image.webp")).toBe(
      "user-1/images/image.webp"
    );
    expect(buildGeneratedVideoStorageKey("user-1", "video-1")).toBe(
      "user-1/videos/video-1.mp4"
    );
  });
});
