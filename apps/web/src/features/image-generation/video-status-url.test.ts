/**
 * 视频状态产物 URL 构造测试。
 *
 * 职责：验证持久 storage key 在进入 UOL 输出前被签名并转成绝对 URL，避免外部 API
 * 返回违反 `z.string().url()` 契约的相对路径。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPublicVideoStatusUrl } from "./video-status-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildPublicVideoStatusUrl", () => {
  it("把视频 storage key 转成可公开访问的绝对签名 URL", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "video-status-test-secret");

    const result = buildPublicVideoStatusUrl({
      storageKey: "users/user-1/videos/video-1.mp4",
      bucket: "generations",
      publicBaseUrl: "https://app.example.test",
    });

    expect(result).toMatch(
      /^https:\/\/app\.example\.test\/api\/storage\/generations\/users\/user-1\/videos\/video-1\.mp4\?sig=[a-f0-9]+&exp=\d+$/
    );
  });

  it("有产物但缺少公开站点基址时显式失败", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "video-status-test-secret");

    expect(() =>
      buildPublicVideoStatusUrl({
        storageKey: "users/user-1/videos/video-1.mp4",
        bucket: "generations",
        publicBaseUrl: "",
      })
    ).toThrow("视频状态 URL 缺少公开站点基址");
  });
});
