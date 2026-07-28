/**
 * 媒体上游 URL 解析测试。
 *
 * 职责：验证管理员配置可使用 HTTP、私网和保留地址，同时继续拒绝无效或非 HTTP(S)
 * 地址，并确保重定向按当前 URL 正确解析。
 */
import { describe, expect, it } from "vitest";

import {
  allowAnyMediaUpstreamAddress,
  parseMediaUpstreamUrl,
  resolveMediaUpstreamRedirect,
} from "./media-upstream-url";

describe("media upstream URL", () => {
  it.each([
    "https://images.example.com/v1",
    "http://127.0.0.1:8080/v1",
    "http://10.0.0.8/v1",
    "http://169.254.169.254/latest/meta-data",
  ])("accepts configured HTTP(S) target %s", (url) => {
    expect(parseMediaUpstreamUrl(url).toString()).toBe(url);
  });

  it.each([
    "not-a-url",
    "ftp://files.example.com/model",
  ])("rejects unusable target %s", (url) => {
    expect(() => parseMediaUpstreamUrl(url)).toThrow(/媒体上游地址/);
  });

  it("resolves relative redirects without applying a network allowlist", () => {
    expect(
      resolveMediaUpstreamRedirect(
        "https://images.example.com/v1/jobs/1",
        "http://127.0.0.1/result.png"
      ).toString()
    ).toBe("http://127.0.0.1/result.png");
    expect(allowAnyMediaUpstreamAddress()).toBe(true);
  });
});
