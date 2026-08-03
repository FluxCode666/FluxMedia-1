/**
 * API 账号视频六操作适配器的 DB-free 测试。
 *
 * 职责：锁定真实模型映射、固定生成/查询路径、双向脚本、同步与异步结果、媒体
 * 令牌及下载信任边界；测试替换网络传输，不访问真实供应商。
 */
import {
  type ApiUpstreamAdapterDraft,
  createDefaultApiUpstreamOperations,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMediaUpstream: vi.fn(),
  fetchMediaUpstreamDownloadWithTrustedOrigin: vi.fn(),
}));

vi.mock("@/features/image-backend-pool/media-upstream-fetch", () => ({
  fetchMediaUpstream: mocks.fetchMediaUpstream,
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

/** 构造一份完整固定版本；单测只覆盖显式修改的操作。 */
function createAdapter(): ApiUpstreamAdapterDraft {
  return {
    baseUrl: "https://video.example.com/v1",
    useStream: false,
    modelMappings: [{ modelId: "seedance2", upstreamModelId: "seedance-2.0" }],
    authentication: { mode: "bearer" },
    credentialScope: "https://video.example.com|bearer",
    operations: createDefaultApiUpstreamOperations(),
  };
}

/** 将固定版本装入现有媒体运行时配置。 */
function createConfig(adapter = createAdapter()): ApiConfig {
  return {
    baseUrl: adapter.baseUrl,
    apiKey: "provider-key",
    model: "seedance2",
    backend: {
      type: "pool-api",
      modelMappings: adapter.modelMappings,
      apiUpstreamAdapter: adapter,
    },
  };
}

const recoveryContext = { trustedOrigin: "https://video.example.com" };

describe("API video adapter", () => {
  afterEach(() => vi.clearAllMocks());

  it("提交映射后的真实模型和独立参数，并只持久化固定查询路径", async () => {
    const adapter = createAdapter();
    adapter.operations["videos.generate"].requestScript = `
      const body = { ...request.body, ratio: request.body.aspect_ratio };
      delete body.aspect_ratio;
      return { body };
    `;
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json(
        {
          id: "upstream-1",
          poll_url: "https://attacker.example/jobs/upstream-1",
        },
        { status: 202 }
      )
    );

    await expect(
      submitApiVideoRequest(createConfig(adapter), {
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
      status: "pending",
      upstreamJobId: "upstream-1",
    });

    const request = mocks.fetchMediaUpstream.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://video.example.com/v1/videos/generations"
    );
    expect(request?.[1]?.headers).toMatchObject({
      Authorization: "Bearer provider-key",
    });
    const body = JSON.parse(String(request?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      client_request_id: "local-video-1",
      model: "seedance-2.0",
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

  it("按沧元 Seedance 协议发送参考图、音频和负面提示词", async () => {
    const adapter = createAdapter();
    adapter.operations["videos.generate"].path = "/videos";
    adapter.operations["videos.generate"].requestScript = `
      const source = request.body;
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new Error("视频请求 Body 必须是对象");
      }
      const body = { ...source };
      const hasFirstFrame = source.first_frame !== undefined;
      const hasLastFrame = source.last_frame !== undefined;
      if (hasFirstFrame !== hasLastFrame) {
        throw new Error("首帧和尾帧必须成对提供");
      }
      const hasFrames = hasFirstFrame || hasLastFrame;
      const hasReferences =
        source.reference_images !== undefined &&
        Array.isArray(source.reference_images) &&
        source.reference_images.length > 0;
      if (
        source.reference_images !== undefined &&
        !Array.isArray(source.reference_images)
      ) {
        throw new Error("reference_images 必须是数组");
      }
      if (hasFrames && hasReferences) {
        throw new Error("首尾帧与参考图不能混用");
      }
      if (hasFrames) {
        body.reference_mode = "frame";
        body.first_image_url = source.first_frame;
        body.last_image_url = source.last_frame;
        delete body.first_frame;
        delete body.last_frame;
      } else if (hasReferences) {
        body.reference_mode = "media";
        body.reference_image_urls = source.reference_images;
        delete body.reference_images;
      }
      return { body };
    `;
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json({ id: "upstream-cangyuan" }, { status: 202 })
    );

    await submitApiVideoRequest(createConfig(adapter), {
      clientRequestId: "local-cangyuan-media",
      prompt: "让主体自然转身".repeat(200),
      model: "seedance2",
      duration: 4,
      aspectRatio: "3:4",
      resolution: "480p",
      effectiveAudio: true,
      negativePrompt: "画面抖动、主体变形",
      referenceImages: [{ data: Buffer.from("reference"), type: "image/png" }],
    });

    const request = mocks.fetchMediaUpstream.mock.calls[0];
    const body = JSON.parse(String(request?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(request?.[0]).toBe("https://video.example.com/v1/videos");
    expect(body).toMatchObject({
      model: "seedance-2.0",
      generate_audio: true,
      negative_prompt: "画面抖动、主体变形",
      reference_mode: "media",
      reference_image_urls: [
        `data:image/png;base64,${Buffer.from("reference").toString("base64")}`,
      ],
    });
    expect(body).not.toHaveProperty("audio");
    expect(body).not.toHaveProperty("reference_images");
  });

  it("允许请求脚本重组首尾帧与多张参考图但不能复制或丢失媒体", async () => {
    const adapter = createAdapter();
    adapter.operations["videos.generate"].requestScript = `
      const body = { ...request.body };
      body.input = {
        start: body.first_frame,
        end: body.last_frame,
        references: body.reference_images,
      };
      delete body.first_frame;
      delete body.last_frame;
      delete body.reference_images;
      return { body };
    `;
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json({ id: "upstream-media" }, { status: 202 })
    );

    await submitApiVideoRequest(createConfig(adapter), {
      clientRequestId: "local-video-media",
      prompt: "prompt",
      model: "seedance2",
      duration: 10,
      aspectRatio: "16:9",
      resolution: "720p",
      effectiveAudio: false,
      firstFrame: { data: Buffer.from("first"), type: "image/png" },
      lastFrame: { data: Buffer.from("last"), type: "image/png" },
      referenceImages: [
        { data: Buffer.from("reference-1"), type: "image/jpeg" },
        { data: Buffer.from("reference-2"), type: "image/webp" },
      ],
    });

    const request = mocks.fetchMediaUpstream.mock.calls[0];
    const body = JSON.parse(String(request?.[1]?.body)) as {
      input?: { start?: string; end?: string; references?: string[] };
    };
    expect(body.input).toEqual({
      start: `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
      end: `data:image/png;base64,${Buffer.from("last").toString("base64")}`,
      references: [
        `data:image/jpeg;base64,${Buffer.from("reference-1").toString("base64")}`,
        `data:image/webp;base64,${Buffer.from("reference-2").toString("base64")}`,
      ],
    });
  });

  it("请求脚本失败时允许切换账号且不发送供应商请求", async () => {
    const adapter = createAdapter();
    adapter.operations["videos.generate"].requestScript =
      'throw new Error("hidden prompt");';

    await expect(
      submitApiVideoRequest(createConfig(adapter), {
        clientRequestId: "local-video-invalid-script",
        prompt: "prompt",
        model: "seedance2",
        duration: 10,
        aspectRatio: "16:9",
        resolution: "720p",
        effectiveAudio: false,
      })
    ).resolves.toEqual({
      error: expect.stringMatching(
        /^供应商请求处理失败，请联系管理员（请求标识：apiu_[a-f0-9]{32}）$/
      ),
      switchable: true,
      upstreamAccepted: false,
      terminal: false,
      submissionUncertain: false,
    });
    expect(mocks.fetchMediaUpstream).not.toHaveBeenCalled();
  });

  it("内置协议把网络、409、5xx 和缺少任务 ID 归为提交结果不确定", async () => {
    mocks.fetchMediaUpstream
      .mockRejectedValueOnce(new Error("private network detail"))
      .mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status: "processing" }));
    const params = {
      clientRequestId: "local-video-1",
      prompt: "prompt",
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      effectiveAudio: false,
    };

    for (let index = 0; index < 4; index += 1) {
      await expect(
        submitApiVideoRequest(createConfig(), params)
      ).resolves.toMatchObject({
        submissionUncertain: true,
        switchable: false,
      });
    }
  });

  it.each([
    401, 403, 429,
  ])("提交返回 %s 时允许切换尚未接受请求的账号", async (status) => {
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json({ private: "provider-key" }, { status })
    );

    await expect(
      submitApiVideoRequest(createConfig(), {
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

  it("生成响应脚本支持同步视频结果且不会追加一次查询", async () => {
    const adapter = createAdapter();
    adapter.operations["videos.generate"].responseScript = `
      return {
        status: "completed",
        outputs: [{ kind: "video", url: response.body.output }]
      };
    `;
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json({
        output: "https://video.example.com/v1/outputs/video.mp4",
      })
    );

    await expect(
      submitApiVideoRequest(createConfig(adapter), {
        clientRequestId: "local-sync",
        prompt: "prompt",
        model: "seedance2",
        duration: 5,
        aspectRatio: "16:9",
        resolution: "720p",
        effectiveAudio: false,
      })
    ).resolves.toMatchObject({
      status: "completed",
      videoUrl: "https://video.example.com/v1/outputs/video.mp4",
    });
    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    { retryable: false, switchable: false, terminal: true },
    { retryable: true, switchable: true, terminal: false },
  ])("生成响应脚本仅按 retryable=$retryable 决定是否允许重投", async ({
    retryable,
    switchable,
    terminal,
  }) => {
    const adapter = createAdapter();
    adapter.operations["videos.generate"].responseScript = `
        return {
          status: "failed",
          error: { category: "rate_limit", code: "video_rate_limited" },
          retryable: ${String(retryable)}
        };
      `;
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json({ status: "rejected" }, { status: 429 })
    );

    await expect(
      submitApiVideoRequest(createConfig(adapter), {
        clientRequestId: "local-scripted-failure",
        prompt: "prompt",
        model: "seedance2",
        duration: 5,
        aspectRatio: "16:9",
        resolution: "720p",
        effectiveAudio: false,
      })
    ).resolves.toMatchObject({
      error: "视频上游拒绝了生成请求",
      switchable,
      upstreamAccepted: false,
      terminal,
      submissionUncertain: false,
    });
  });

  it("查询只使用固定路径和任务 ID，并由响应脚本采用五秒默认轮询", async () => {
    const adapter = createAdapter();
    adapter.operations["videos.query"] = {
      path: "/vendor/tasks/{task_id}",
      requestScript: 'return { query: { detail: "full" } };',
      responseScript: `
        return response.body.done
          ? {
              status: "completed",
              outputs: [{ kind: "video", url: response.body.output }]
            }
          : { status: "processing" };
      `,
    };
    mocks.fetchMediaUpstream
      .mockResolvedValueOnce(Response.json({ done: false }))
      .mockResolvedValueOnce(
        Response.json({ done: true, output: "https://cdn.example/video.mp4" })
      );

    await expect(
      pollApiVideoRequest(createConfig(adapter), "job/id 1", recoveryContext)
    ).resolves.toMatchObject({
      status: "pending",
      pollAfterSeconds: 5,
    });
    await expect(
      pollApiVideoRequest(createConfig(adapter), "job/id 1", recoveryContext)
    ).resolves.toMatchObject({
      status: "completed",
      videoUrl: "https://cdn.example/video.mp4",
    });
    expect(mocks.fetchMediaUpstream.mock.calls[0]?.[0]).toBe(
      "https://video.example.com/v1/vendor/tasks/job%2Fid%201?detail=full"
    );
  });

  it("查询响应脚本失败发生在外呼后并计入连续适配失败", async () => {
    const adapter = createAdapter();
    adapter.operations["videos.query"].responseScript =
      'throw new Error("hidden provider body");';
    mocks.fetchMediaUpstream.mockResolvedValue(Response.json({ secret: true }));

    await expect(
      pollApiVideoRequest(createConfig(adapter), "job-1", recoveryContext)
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /^供应商请求处理失败，请联系管理员（请求标识：apiu_[a-f0-9]{32}）$/
      ),
      retryable: true,
      countsTowardAdapterFailure: true,
    });
    expect(mocks.fetchMediaUpstream).toHaveBeenCalledTimes(1);
  });

  it("内置查询失败时保留有界且脱敏的上游错误原因", async () => {
    mocks.fetchMediaUpstream.mockResolvedValue(
      Response.json({
        id: "upstream-failed",
        status: "failed",
        error: {
          code: "",
          message:
            "视频生成失败，token=sk-sensitive；参考素材已上传，但模型临时异常。",
        },
      })
    );

    await expect(
      pollApiVideoRequest(createConfig(), "upstream-failed", recoveryContext)
    ).rejects.toThrow(
      "API 视频任务失败：视频生成失败，token=[REDACTED]；参考素材已上传，但模型临时异常。"
    );
  });

  it("固定版本 origin 与任务可信源不一致时不会外呼", async () => {
    await expect(
      pollApiVideoRequest(createConfig(), "job-1", {
        trustedOrigin: "http://10.0.0.8",
      })
    ).rejects.toMatchObject({
      message: "供应商请求处理失败，请联系管理员",
      countsTowardAdapterFailure: true,
    });
    expect(mocks.fetchMediaUpstream).not.toHaveBeenCalled();
  });

  it("下载视频时使用提交时可信源和统一字节上限", async () => {
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
