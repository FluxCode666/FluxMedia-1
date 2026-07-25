/**
 * Images API 不可见 nonce 的纯函数回归测试。
 *
 * 使用方：Vitest；确保缓存规避不改变用户可见提示词。
 */
import { describe, expect, it } from "vitest";
import {
  appendImagesUpstreamNonce,
  buildInvisibleNonce,
} from "./images-upstream-nonce";

const ZERO_WIDTH = /\u200b|\u200c|\u200d|\u2060/g;

describe("appendImagesUpstreamNonce", () => {
  it("剥离零宽 nonce 后保留原提示词", () => {
    const prompt = "a cute cat sitting on the sofa";
    const output = appendImagesUpstreamNonce(prompt);
    expect(output.startsWith(prompt)).toBe(true);
    expect(output.replace(ZERO_WIDTH, "")).toBe(prompt);
  });

  it("相同提示词的两次请求具有不同字节内容", () => {
    const prompt = "same reference image, same prompt words";
    expect(appendImagesUpstreamNonce(prompt)).not.toBe(
      appendImagesUpstreamNonce(prompt)
    );
  });

  it("nonce 非空且仅包含零宽字符", () => {
    const nonce = buildInvisibleNonce();
    expect(nonce.length).toBeGreaterThan(0);
    expect(nonce.replace(ZERO_WIDTH, "")).toBe("");
  });
});
