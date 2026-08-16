/**
 * 视频报价 token 的 DB-free 安全边界测试。
 *
 * 使用方：Shared Vitest；覆盖域签名、主体、模型/分辨率报价隔离与畸形输入。
 */
import { describe, expect, it } from "vitest";

import {
  assertVideoQuoteToken,
  createVideoQuoteDigest,
  encodeVideoQuoteToken,
  VideoQuoteTokenError,
} from "./video-quote-token";

const secret = "test-secret-that-is-not-used-in-production";

/** 构造稳定的单模型当前报价摘要。 */
function createDigest(
  overrides?: Partial<Parameters<typeof createVideoQuoteDigest>[0]>
) {
  return createVideoQuoteDigest({
    modelId: "veo31",
    resolution: "1080p",
    mode: "per_item",
    unitPrice: 3,
    billingGroupId: "group-1",
    modelConfigurationRevision: 2,
    ...overrides,
  });
}

describe("video quote token", () => {
  it("只接受同一 Principal scope 和同一模型分辨率报价", () => {
    const quoteDigest = createDigest();
    const token = encodeVideoQuoteToken(
      { principalScope: "user:user-1", quoteDigest },
      secret
    );
    expect(() =>
      assertVideoQuoteToken(
        token,
        { principalScope: "user:user-1", quoteDigest },
        secret
      )
    ).not.toThrow();
    expect(() =>
      assertVideoQuoteToken(
        token,
        {
          principalScope: "user:user-1",
          quoteDigest: createDigest({ resolution: "720p" }),
        },
        secret
      )
    ).toThrow(VideoQuoteTokenError);
  });

  it("拒绝跨用户、跨 API Key、截断、超长和改写签名", () => {
    const quoteDigest = createDigest();
    const token = encodeVideoQuoteToken(
      { principalScope: "external:user-1:key-1", quoteDigest },
      secret
    );
    const invalid = [
      token.slice(0, -1),
      `${token}x`,
      "x".repeat(2_049),
      "not-a-token",
    ];
    for (const value of invalid) {
      expect(() =>
        assertVideoQuoteToken(
          value,
          {
            principalScope: "external:user-1:key-1",
            quoteDigest,
          },
          secret
        )
      ).toThrow(VideoQuoteTokenError);
    }
    expect(() =>
      assertVideoQuoteToken(
        token,
        { principalScope: "external:user-1:key-2", quoteDigest },
        secret
      )
    ).toThrow(VideoQuoteTokenError);
  });

  it.each([
    { modelId: "veo31-fast" },
    { resolution: "720p" },
    { mode: "per_second" as const },
    { unitPrice: 4 },
    { billingGroupId: "group-2" },
    { modelConfigurationRevision: 3 },
  ])("选中报价事实 $modelId$resolution$mode 改变时摘要失效", (change) => {
    expect(createDigest(change)).not.toBe(createDigest());
  });

  it("相同选中报价始终生成相同摘要且不依赖整个模型目录", () => {
    expect(createDigest()).toBe(createDigest());
  });
});
