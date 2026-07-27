/**
 * 媒体上游 URL 安全策略测试。
 *
 * 职责：验证 API 与 Adobe gateway 共用的 HTTPS、地址解析和重定向复验边界，
 * 防止管理员配置或 DNS 重绑定把凭据发送到内网与云元数据服务。
 */
import { describe, expect, it, vi } from "vitest";

import {
  assertSafeMediaUpstreamRedirect,
  assertSafeMediaUpstreamUrl,
} from "./outbound-url-security";

describe("media upstream URL security", () => {
  it("accepts a public HTTPS upstream", async () => {
    await expect(
      assertSafeMediaUpstreamUrl("https://images.example.com/v1", {
        resolve: vi.fn().mockResolvedValue(["8.8.8.8"]),
      })
    ).resolves.toMatchObject({ hostname: "images.example.com" });
  });

  it.each([
    "http://images.example.com/v1",
    "https://user:password@images.example.com/v1",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://192.0.2.1/v1",
    "https://198.51.100.1/v1",
    "https://203.0.113.1/v1",
    "https://[::1]/v1",
    "https://[2001:db8::1]/v1",
  ])("rejects unsafe literal target %s", async (url) => {
    await expect(assertSafeMediaUpstreamUrl(url)).rejects.toThrow(
      /unsafe media upstream/i
    );
  });

  it("rejects a hostname when any resolved address is private", async () => {
    await expect(
      assertSafeMediaUpstreamUrl("https://rebind.example.com/v1", {
        resolve: vi.fn().mockResolvedValue(["8.8.8.8", "10.0.0.5"]),
      })
    ).rejects.toThrow(/private|reserved/i);
  });

  it("resolves on every validation so DNS rebinding is detected", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(["8.8.8.8"])
      .mockResolvedValueOnce(["10.0.0.5"]);

    await expect(
      assertSafeMediaUpstreamUrl("https://rebind.example.com/v1", {
        resolve,
      })
    ).resolves.toBeDefined();
    await expect(
      assertSafeMediaUpstreamUrl("https://rebind.example.com/v1", {
        resolve,
      })
    ).rejects.toThrow(/private|reserved/i);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("revalidates cross-host redirects and rejects private destinations", async () => {
    await expect(
      assertSafeMediaUpstreamRedirect(
        "https://images.example.com/v1",
        "https://redirect.example.com/result",
        { resolve: vi.fn().mockResolvedValue(["10.0.0.8"]) }
      )
    ).rejects.toThrow(/private|reserved/i);
  });
});
