/**
 * 最近图片展示 URL 规则测试。
 *
 * 使用方是 Vitest；锁定站内成品只以 320px 缩略图进入网格，第三方图片保持原地址。
 */

import { describe, expect, it } from "vitest";

import { getRecentImageDisplayUrl } from "./recent-image-display";

describe("getRecentImageDisplayUrl", () => {
  it("把站内签名原图改写为 320px 路径缩略图", () => {
    expect(
      getRecentImageDisplayUrl(
        "/api/storage/media/user/image.png?sig=deadbeef&exp=123"
      )
    ).toBe("/api/storage/media/w320/user/image.png?sig=deadbeef&exp=123");
  });

  it("第三方图片地址保持不变", () => {
    expect(getRecentImageDisplayUrl("https://cdn.example.com/image.png")).toBe(
      "https://cdn.example.com/image.png"
    );
  });
});
