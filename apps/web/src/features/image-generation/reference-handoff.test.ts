/**
 * 图库参考图交接参数的 DB-free 边界测试。
 *
 * 使用方是创作页客户端接入层；测试锁定站内存储 URL、一次性意图一致性、重复参数
 * 拒绝策略，以及消费后仅清理交接参数的行为。
 */

import { describe, expect, it } from "vitest";

import {
  parseReferenceHandoffIntent,
  removeReferenceHandoffParams,
} from "./reference-handoff";

describe("parseReferenceHandoffIntent", () => {
  it("解析图库灯箱生成的站内参考图交接参数", () => {
    const params = new URLSearchParams({
      mode: "image",
      ref: "/api/storage/generations/user/image.png?sig=abc&exp=123",
      sourceId: "generation-1",
      sourceName: "作品一.png",
      intent: "handoff-1",
      sendRef: "handoff-1",
    });

    expect(parseReferenceHandoffIntent(params)).toEqual({
      id: "handoff-1",
      imageUrl: "/api/storage/generations/user/image.png?sig=abc&exp=123",
      sourceId: "generation-1",
      sourceName: "作品一.png",
    });
  });

  it.each([
    "mode=image&ref=https%3A%2F%2Fevil.example%2Fimage.png&sourceId=1&sourceName=a.png&intent=x&sendRef=x",
    "mode=chat&ref=%2Fapi%2Fstorage%2Fgenerations%2Fa.png&sourceId=1&sourceName=a.png&intent=x&sendRef=x",
    "mode=image&ref=%2Fapi%2Fstorage%2Fgenerations%2Fa.png&sourceId=1&sourceName=a.png&intent=x&sendRef=y",
    "mode=image&ref=%2Fapi%2Fstorage%2Fgenerations%2Fa.png&ref=%2Fapi%2Fstorage%2Fgenerations%2Fb.png&sourceId=1&sourceName=a.png&intent=x&sendRef=x",
  ])("拒绝非法或有歧义的图库交接：%s", (query) => {
    expect(parseReferenceHandoffIntent(new URLSearchParams(query))).toBeNull();
  });
});

describe("removeReferenceHandoffParams", () => {
  it("只清理一次性交接参数并保留其他查询参数与 hash", () => {
    const currentUrl = new URL(
      "https://flux.example/zh/dashboard/generate?tab=advanced&mode=image&ref=%2Fapi%2Fstorage%2Fgenerations%2Fa.png&sourceId=1&sourceName=a.png&intent=x&sendRef=x#workspace"
    );

    expect(removeReferenceHandoffParams(currentUrl)).toBe(
      "/zh/dashboard/generate?tab=advanced#workspace"
    );
    expect(currentUrl.searchParams.get("ref")).toBe(
      "/api/storage/generations/a.png"
    );
  });
});
