/**
 * API 账号视频兼容协议的 DB-free 测试。
 *
 * 职责：锁定真实模型 ID 与独立参数请求、参数映射、任务身份解析、原账号轮询和
 * 跨源凭据隔离；测试替换网络传输，不访问真实上游。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMediaUpstream: vi.fn(),
  fetchPublicMediaUpstream: vi.fn(),
  fetchMediaUpstreamDownloadWithTrustedOrigin: vi.fn(),
}));

vi.mock("@/features/image-backend-pool/media-upstream-fetch", () => ({
  fetchMediaUpstream: mocks.fetchMediaUpstream,
  fetchPublicMediaUpstream: mocks.fetchPublicMediaUpstream,
  fetchMediaUpstreamDownloadWithTrustedOrigin:
    mocks.fetchMediaUpstreamDownloadWithTrustedOrigin,
  MAX_VIDEO_UPSTREAM_DOWNLOAD_BYTES: 512 * 1024 * 1024,
}));

import {
  downloadApiVideoRequest,
  pollApiVideoRequest,
  submitApiVideoRequest,
} from "./api-video";
import type { ApiConfig } from "./types";

const config: ApiConfig = {
  baseUrl: "https://video.example.com/v1",
  apiKey: "provider-key",
  backend: {
    type: "pool-api",
    parameterMappings: [
      { source: "aspect_ratio", target: "ratio", mode: "move" },
    ],
  },
};
const recoveryContext = { trustedOrigin: "https://video.example.com" };

describe("API video adapter", () => {
  afterEach(() => vi.clearAllMocks());

  it("提交真实模型 ID、独立参数和具名输入，并解析持久任务身份", async () => {
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json({ object: "video.task", id: "upstream-1" }, { status: 202 })
    );

    await expect(
      submitApiVideoRequest(config, {
        clientRequestId: "local-video-1",
        prompt: "prompt",
        model: "seedance2",
        duration: 15,
        aspectRatio: "9:16",
        resolution: "480p",
        effectiveAudio: true,
        firstFrame: { data: Buffer.from("frame"), type: "image/png" },
      })
    ).resolves.toMatchObject({
      upstreamJobId: "upstream-1",
      pollUrl: "https://video.example.com/v1/videos/upstream-1",
    });

    const request = mocks.fetchMediaUpstream.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://video.example.com/v1/videos/generations"
    );
    const body = JSON.parse(String(request?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      client_request_id: "local-video-1",
      model: "seedance2",
      duration: 15,
      ratio: "9:16",
      resolution: "480p",
      generate_audio: true,
    });
    expect(body).not.toHaveProperty("aspect_ratio");
    expect(body.first_frame).toBe(
      `data:image/png;base64,${Buffer.from("frame").toString("base64")}`
    );
  });

  it("409、5xx 或成功响应缺少任务 ID 时标记提交结果不确定", async () => {
    mocks.fetchMediaUpstream
      .mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status: "processing" }))
      .mockResolvedValueOnce(
        Response.json({ error: "idempotency pending" }, { status: 409 })
      );

    const params = {
      clientRequestId: "local-video-1",
      prompt: "prompt",
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      effectiveAudio: false,
    };
    await expect(submitApiVideoRequest(config, params)).resolves.toMatchObject({
      submissionUncertain: true,
      switchable: false,
    });
    await expect(submitApiVideoRequest(config, params)).resolves.toMatchObject({
      submissionUncertain: true,
      switchable: false,
    });
    await expect(submitApiVideoRequest(config, params)).resolves.toMatchObject({
      submissionUncertain: true,
      switchable: false,
    });
  });

  it.each([
    401, 403, 429,
  ])("提交返回 %s 时允许切换尚未接受请求的账号", async (status) => {
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json(
        { error: { message: "Bearer provider-key at private URL" } },
        { status }
      )
    );

    await expect(
      submitApiVideoRequest(config, {
        clientRequestId: "local-video-1",
        prompt: "prompt",
        model: "seedance2",
        duration: 15,
        aspectRatio: "9:16",
        resolution: "480p",
        effectiveAudio: false,
      })
    ).resolves.toEqual({
      error: `视频上游返回 HTTP ${status}`,
      switchable: true,
      upstreamAccepted: false,
      terminal: false,
      submissionUncertain: false,
    });
  });

  it("提交成功但恢复地址非法时保留原任务待核对", async () => {
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json({ id: "upstream-1", poll_url: "file:///private/status" })
    );

    await expect(
      submitApiVideoRequest(config, {
        clientRequestId: "local-video-1",
        prompt: "prompt",
        model: "seedance2",
        duration: 15,
        aspectRatio: "9:16",
        resolution: "480p",
        effectiveAudio: false,
      })
    ).resolves.toEqual({
      error: "API 视频提交成功但恢复地址无效",
      switchable: false,
      upstreamAccepted: true,
      terminal: false,
      submissionUncertain: true,
    });
  });

  it("网络与上游正文错误不会泄露地址或凭据", async () => {
    mocks.fetchMediaUpstream
      .mockRejectedValueOnce(
        new Error("request https://private.example/?token=provider-key failed")
      )
      .mockResolvedValueOnce(
        Response.json(
          { message: "Bearer provider-key at https://private.example" },
          { status: 400 }
        )
      );
    const params = {
      clientRequestId: "local-video-1",
      prompt: "prompt",
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      effectiveAudio: false,
    };

    await expect(submitApiVideoRequest(config, params)).resolves.toMatchObject({
      error: "API 视频提交网络错误",
    });
    await expect(submitApiVideoRequest(config, params)).resolves.toMatchObject({
      error: "视频上游返回 HTTP 400",
    });
  });

  it("轮询同源状态地址时携带账号密钥，跨源地址不携带", async () => {
    mocks.fetchMediaUpstream.mockResolvedValueOnce(
      Response.json({ status: "processing" })
    );
    mocks.fetchPublicMediaUpstream.mockResolvedValueOnce(
      Response.json({
        status: "completed",
        video_url: "https://cdn.example.com/video.mp4",
      })
    );

    await expect(
      pollApiVideoRequest(
        config,
        "https://video.example.com/v1/videos/job-1",
        recoveryContext
      )
    ).resolves.toEqual({
      status: "pending",
      raw: { status: "processing" },
    });
    await expect(
      pollApiVideoRequest(
        config,
        "https://status.example.net/jobs/job-1",
        recoveryContext
      )
    ).resolves.toMatchObject({
      status: "completed",
      videoUrl: "https://cdn.example.com/video.mp4",
    });
    expect(mocks.fetchMediaUpstream.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer provider-key",
    });
    expect(
      mocks.fetchPublicMediaUpstream.mock.calls[0]?.[1]?.headers
    ).not.toHaveProperty("Authorization");
  });

  it("解析相对视频地址并把已接受任务的鉴权错误保留为原账号重试", async () => {
    mocks.fetchMediaUpstream
      .mockResolvedValueOnce(
        Response.json({ status: "completed", video_url: "outputs/video.mp4" })
      )
      .mockResolvedValueOnce(
        Response.json({ message: "Bearer provider-key" }, { status: 401 })
      );

    await expect(
      pollApiVideoRequest(
        config,
        "https://video.example.com/v1/videos/job-1",
        recoveryContext
      )
    ).resolves.toMatchObject({
      status: "completed",
      videoUrl: "https://video.example.com/v1/outputs/video.mp4",
    });
    await expect(
      pollApiVideoRequest(
        config,
        "https://video.example.com/v1/videos/job-1",
        recoveryContext
      )
    ).rejects.toMatchObject({
      message: "视频上游返回 HTTP 401",
      retryable: true,
      statusCode: 401,
    });
  });

  it("账号 Base URL 变更后不向新源授予原任务凭据或私网信任", async () => {
    mocks.fetchPublicMediaUpstream.mockResolvedValue(
      Response.json({ status: "processing" })
    );
    const movedConfig = {
      ...config,
      baseUrl: "http://10.0.0.8/v1",
      apiKey: "new-provider-key",
    };

    await expect(
      pollApiVideoRequest(
        movedConfig,
        "http://10.0.0.8/v1/videos/job-1",
        recoveryContext
      )
    ).resolves.toMatchObject({ status: "pending" });
    expect(mocks.fetchMediaUpstream).not.toHaveBeenCalled();
    expect(mocks.fetchPublicMediaUpstream).toHaveBeenCalledWith(
      "http://10.0.0.8/v1/videos/job-1",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      })
    );
  });

  it("下载视频时使用统一限流下载器", async () => {
    mocks.fetchMediaUpstreamDownloadWithTrustedOrigin.mockResolvedValue(
      new Response(Buffer.from("video"), { status: 200 })
    );

    await expect(
      downloadApiVideoRequest(
        "https://cdn.example.com/video.mp4",
        recoveryContext
      )
    ).resolves.toEqual(Buffer.from("video"));
    expect(
      mocks.fetchMediaUpstreamDownloadWithTrustedOrigin
    ).toHaveBeenCalledWith(
      "https://cdn.example.com/video.mp4",
      "https://video.example.com",
      expect.objectContaining({ maxResponseBytes: 512 * 1024 * 1024 })
    );
  });
});
