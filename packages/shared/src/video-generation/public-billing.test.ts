/**
 * 视频公共计费 DTO 的 DB-free 契约测试。
 *
 * 使用方：Shared Vitest；验证内部报价只投影允许公开的模式字段与兼容别名。
 */
import { describe, expect, it } from "vitest";

import {
  projectVideoCurrentQuote,
  videoCurrentQuoteSchema,
} from "./public-billing";

describe("video public billing", () => {
  it("按秒当前报价保留同义 creditsPerSecond", () => {
    expect(
      projectVideoCurrentQuote(
        {
          modelId: "veo31",
          resolution: "1080p",
          mode: "per_second",
          unit: "second",
          unitPrice: 2,
          creditsPerSecond: 2,
          durationSeconds: 5,
          quotedCredits: 10,
          priceSource: "group_resolution",
        },
        "opaque-token"
      )
    ).toEqual({
      kind: "current_quote",
      resolution: "1080p",
      mode: "per_second",
      unit: "second",
      unitPrice: 2,
      creditsPerSecond: 2,
      quoteToken: "opaque-token",
    });
  });

  it("按条当前报价不伪造按秒兼容字段或内部价格来源", () => {
    const quote = projectVideoCurrentQuote(
      {
        modelId: "veo31",
        resolution: "1080p",
        mode: "per_item",
        unit: "item",
        unitPrice: 3,
        durationSeconds: 10,
        quotedCredits: 3,
        priceSource: "global_resolution",
      },
      "opaque-token"
    );

    expect(quote).toEqual({
      kind: "current_quote",
      resolution: "1080p",
      mode: "per_item",
      unit: "item",
      unitPrice: 3,
      quoteToken: "opaque-token",
    });
    expect(JSON.stringify(quote)).not.toMatch(
      /creditsPerSecond|priceSource|group|revision/
    );
    expect(videoCurrentQuoteSchema.safeParse(quote).success).toBe(true);
  });
});
