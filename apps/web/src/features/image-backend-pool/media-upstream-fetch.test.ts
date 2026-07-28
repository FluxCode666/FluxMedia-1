/**
 * 统一媒体上游请求测试。
 *
 * 职责：验证上游请求使用连接层 DNS pin，允许 HTTP/私网目标，媒体下载逐跳解析
 * 重定向并维持响应大小限制。测试替换真实传输，不访问网络。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithDnsPin: vi.fn(),
}));

vi.mock("@repo/shared/security/dns-pin", () => ({
  fetchWithDnsPin: mocks.fetchWithDnsPin,
}));

import {
  fetchMediaUpstream,
  fetchMediaUpstreamDownload,
} from "./media-upstream-fetch";

describe("media upstream fetch", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("pins API requests and forwards only explicit provider headers", async () => {
    mocks.fetchWithDnsPin.mockResolvedValue(new Response("ok"));

    await fetchMediaUpstream("https://8.8.8.8/v1/images/generations", {
      method: "POST",
      headers: { Authorization: "Bearer provider-key" },
      body: "{}",
      maxResponseBytes: 1024,
    });

    expect(mocks.fetchWithDnsPin).toHaveBeenCalledWith(
      "https://8.8.8.8/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer provider-key" },
        body: "{}",
        maxResponseBytes: 1024,
        timeoutMs: 20 * 60 * 1000,
        allowBlockedAddress: expect.any(Function),
      })
    );
  });

  it("preserves an explicit shorter caller timeout", async () => {
    mocks.fetchWithDnsPin.mockResolvedValue(new Response("ok"));

    await fetchMediaUpstream("https://8.8.8.8/v1/images/generations", {
      timeoutMs: 45_000,
    });

    expect(mocks.fetchWithDnsPin).toHaveBeenCalledWith(
      "https://8.8.8.8/v1/images/generations",
      expect.objectContaining({ timeoutMs: 45_000 })
    );
  });

  it("follows a media response redirect to a private HTTP target", async () => {
    mocks.fetchWithDnsPin
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        })
      )
      .mockResolvedValueOnce(new Response("image"));

    await expect(
      fetchMediaUpstreamDownload("https://8.8.8.8/image.png")
    ).resolves.toBeInstanceOf(Response);
    expect(mocks.fetchWithDnsPin).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1/private",
      expect.objectContaining({ allowBlockedAddress: expect.any(Function) })
    );
  });

  it("enforces the caller-selected video byte limit on every redirect hop", async () => {
    mocks.fetchWithDnsPin
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://8.8.4.4/video.mp4" },
        })
      )
      .mockResolvedValueOnce(new Response("video"));

    await fetchMediaUpstreamDownload("https://8.8.8.8/job", {
      maxResponseBytes: 512 * 1024 * 1024,
    });

    expect(mocks.fetchWithDnsPin).toHaveBeenCalledTimes(2);
    expect(mocks.fetchWithDnsPin).toHaveBeenNthCalledWith(
      2,
      "https://8.8.4.4/video.mp4",
      expect.objectContaining({ maxResponseBytes: 512 * 1024 * 1024 })
    );
  });

  it("allows a private upstream without a deployment allowlist", async () => {
    mocks.fetchWithDnsPin.mockResolvedValue(new Response("ok"));

    await fetchMediaUpstream("https://10.0.0.8/v1", {
      maxResponseBytes: 1024,
    });

    const options = mocks.fetchWithDnsPin.mock.calls[0]?.[1] as
      | {
          allowBlockedAddress?: (input: {
            hostname: string;
            address: string;
          }) => boolean;
        }
      | undefined;
    expect(
      options?.allowBlockedAddress?.({
        hostname: "10.0.0.8",
        address: "10.0.0.8",
      })
    ).toBe(true);
  });
});
