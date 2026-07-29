/**
 * 存储 URL 与归属工具的 DB-free 单测
 *
 * 覆盖 isExternalUrl / getAvatarUrl / generateAvatarKey（C-L16）以及
 * keyBelongsToUser / isBucketAllowed（C-M19，归属与白名单的纯逻辑）。
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  generateAvatarKey,
  getAvatarUrl,
  isBucketAllowed,
  isExternalUrl,
  keyBelongsToUser,
  parseAvatarStorageBucketName,
} from "./utils";

describe("isExternalUrl", () => {
  it("识别 http/https 链接为外部 URL", () => {
    expect(isExternalUrl("http://example.com/a.png")).toBe(true);
    expect(isExternalUrl("https://example.com/a.png")).toBe(true);
  });

  it("非 http(s) scheme 与存储键名不算外部 URL", () => {
    expect(isExternalUrl("ftp://example.com/a.png")).toBe(false);
    expect(isExternalUrl("user-1-123.png")).toBe(false);
    expect(isExternalUrl("/api/storage/avatars/x.png")).toBe(false);
  });

  it("空值返回 false", () => {
    expect(isExternalUrl(null)).toBe(false);
    expect(isExternalUrl(undefined)).toBe(false);
    expect(isExternalUrl("")).toBe(false);
  });
});

describe("getAvatarUrl", () => {
  const previousBucket = process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME;

  afterEach(() => {
    if (previousBucket === undefined) {
      delete process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME;
    } else {
      process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME = previousBucket;
    }
  });

  it("空值返回 undefined", () => {
    expect(getAvatarUrl(null)).toBeUndefined();
    expect(getAvatarUrl(undefined)).toBeUndefined();
    expect(getAvatarUrl("")).toBeUndefined();
  });

  it("外部 URL 原样返回", () => {
    const url = "https://avatars.githubusercontent.com/u/12345";
    expect(getAvatarUrl(url)).toBe(url);
  });

  it("存储键名使用稳定头像读取别名", () => {
    delete process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME;
    expect(getAvatarUrl("user-1-123.png")).toBe(
      "/api/storage/_avatars/user-1-123.png"
    );
  });

  it("构建期 bucket 改变时仍使用稳定头像读取别名", () => {
    process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME = "my-avatars";
    expect(getAvatarUrl("user-1-123.png")).toBe(
      "/api/storage/_avatars/user-1-123.png"
    );
  });
});

describe("generateAvatarKey", () => {
  const makeFile = (name: string): File => ({ name }) as unknown as File;

  it("以 userId 前缀开头并归一扩展名为小写", () => {
    const key = generateAvatarKey("user-1", makeFile("Photo.PNG"));
    expect(key.startsWith("avatars/user-1-")).toBe(true);
    expect(key.endsWith(".png")).toBe(true);
  });

  it("文件名无点号时把整名当作扩展名（split('.').pop() 行为）", () => {
    const key = generateAvatarKey("user-1", makeFile("photo"));
    expect(key.startsWith("avatars/user-1-")).toBe(true);
    expect(key.endsWith(".photo")).toBe(true);
  });

  it("多级扩展名只取最后一段并小写", () => {
    const key = generateAvatarKey("user-1", makeFile("archive.TAR.GZ"));
    expect(key.endsWith(".gz")).toBe(true);
  });
});

describe("keyBelongsToUser", () => {
  it("头像命名空间中的用户 ID 前缀返回 true", () => {
    expect(keyBelongsToUser("avatars/user-1-123.png", "user-1")).toBe(true);
  });

  it("以 ${userId}- 前缀开头返回 true", () => {
    expect(keyBelongsToUser("user-1-123.png", "user-1")).toBe(true);
  });

  it("以 ${userId}/ 前缀开头返回 true", () => {
    expect(keyBelongsToUser("user-1/nested/a.png", "user-1")).toBe(true);
  });

  it("与 ${userId} 完全相等返回 true", () => {
    expect(keyBelongsToUser("user-1", "user-1")).toBe(true);
  });

  it("他人 key 返回 false", () => {
    expect(keyBelongsToUser("user-2-123.png", "user-1")).toBe(false);
  });

  it("子串混淆攻击（userId 为另一 userId 的前缀）应返回 false（防回归）", () => {
    // 旧实现用 key.includes(userId)，此处会被绕过返回 true，新实现锚定边界返回 false
    expect(keyBelongsToUser("user-12-evil.png", "user-1")).toBe(false);
  });

  it("userId 出现在 key 中间不算归属", () => {
    expect(keyBelongsToUser("victim/user-1-x.png", "user-1")).toBe(false);
  });

  it.each([
    "avatars/user-1/../../logo/system.svg",
    "avatars/user-1/../user-2/avatar.png",
    "avatars/user-1//avatar.png",
    "avatars/user-1\\avatar.png",
  ])("拒绝不安全头像 key：%s", (key) => {
    expect(keyBelongsToUser(key, "user-1")).toBe(false);
  });

  it("空 userId 返回 false", () => {
    expect(keyBelongsToUser("anything", "")).toBe(false);
  });
});

describe("parseAvatarStorageBucketName", () => {
  it("允许头像与其他公开资产共桶", () => {
    expect(parseAvatarStorageBucketName(" system-assets ", "generations")).toBe(
      "system-assets"
    );
  });

  it("头像与生成内容共桶时 fail-closed", () => {
    expect(() => parseAvatarStorageBucketName("shared", " shared ")).toThrow(
      "生成内容存储桶必须与头像存储桶隔离"
    );
  });

  it("头像 bucket 使用保留逻辑别名时 fail-closed", () => {
    expect(() =>
      parseAvatarStorageBucketName("_avatars", "generations")
    ).toThrow("存储桶配置无效");
  });

  it.each([
    ["头像设置为空", "", "generations"],
    ["生成内容设置为空", "avatars", ""],
  ])("%s时拒绝", (_label, avatars, generations) => {
    expect(() => parseAvatarStorageBucketName(avatars, generations)).toThrow(
      "存储桶配置无效"
    );
  });
});

describe("isBucketAllowed", () => {
  it("白名单内返回 true", () => {
    expect(isBucketAllowed("avatars", ["avatars"])).toBe(true);
  });

  it("白名单外返回 false", () => {
    expect(isBucketAllowed("generations", ["avatars"])).toBe(false);
  });

  it("空白名单一律返回 false", () => {
    expect(isBucketAllowed("avatars", [])).toBe(false);
  });
});
