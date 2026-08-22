/**
 * Gemini 上游视频适配器测试。
 *
 * 通过替换媒体上游请求验证请求嵌套、成员认证、Operation 接受和终态错误；不访问真实
 * 网络或数据库。
 */

import type { ApiUpstreamAdapterDraft } from "@repo/shared/image-backend/api-upstream-adaptation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMediaUpstream } = vi.hoisted(() => ({
  fetchMediaUpstream: vi.fn(),
}));

vi.mock("@/features/image-backend-pool/media-upstream-fetch", () => ({
  fetchMediaUpstream,
}));

import {
  pollGeminiVideoRequest,
  submitGeminiVideoRequest,
} from "./gemini-video";

const adapter: ApiUpstreamAdapterDraft = {
  baseUrl: "https://generativelanguage.googleapis.com",
  useStream: false,
  videoSubmissionRetryCount: 2,
  videoProtocolMode: "gemini",
  modelMappings: [],
  authentication: { mode: "bearer" },
  credentialScope: "https://generativelanguage.googleapis.com|bearer",
  operations: {
    "images.generate": { path: "", requestScript: "", responseScript: "" },
    "images.generate.query": {
      path: "",
      requestScript: "",
      responseScript: "",
    },
    "images.edit": { path: "", requestScript: "", responseScript: "" },
    "images.edit.query": {
      path: "",
      requestScript: "",
      responseScript: "",
    },
    "videos.generate": {
      path: "",
      requestScript: "",
      responseScript: "",
    },
    "videos.query": { path: "", requestScript: "", responseScript: "" },
  },
};

describe("Gemini video upstream adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends predictLongRunning with member x-goog-api-key only", async () => {
    fetchMediaUpstream.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "models/veo-3.1-generate-preview/operations/op-123",
          done: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const result = await submitGeminiVideoRequest({
      adapter,
      apiKey: "member-secret",
      upstreamModel: "veo-3.1-generate-preview",
      prompt: "A lighthouse at sunset",
      duration: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      effectiveAudio: true,
    });
    expect(result).toMatchObject({
      status: "pending",
      upstreamOperationName:
        "models/veo-3.1-generate-preview/operations/op-123",
    });
    const [url, init] = fetchMediaUpstream.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning"
    );
    expect(init.headers).toMatchObject({
      "x-goog-api-key": "member-secret",
      "content-type": "application/json",
    });
    expect(
      (init.headers as Record<string, string>).Authorization
    ).toBeUndefined();
    expect(JSON.parse(String(init.body))).toMatchObject({
      instances: [{ prompt: "A lighthouse at sunset" }],
      parameters: {
        aspectRatio: "16:9",
        resolution: "1080p",
        durationSeconds: "8",
      },
    });
  });

  it("rejects explicit audio disable and fails terminal Operation errors", async () => {
    const rejected = await submitGeminiVideoRequest({
      adapter,
      apiKey: "member-secret",
      upstreamModel: "veo-3.1-generate-preview",
      prompt: "test",
      duration: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      effectiveAudio: false,
    });
    expect(rejected).toMatchObject({
      error: expect.stringContaining("关闭音频"),
    });

    fetchMediaUpstream.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "models/veo-3.1-generate-preview/operations/op-123",
          done: true,
          error: { code: 7, message: "permission denied" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    await expect(
      pollGeminiVideoRequest({
        adapter,
        apiKey: "member-secret",
        operationName: "models/veo-3.1-generate-preview/operations/op-123",
      })
    ).rejects.toMatchObject({ retryable: false });
  });

  it("reserves the submission attempt before sending", async () => {
    const onBeforeSend = vi.fn(async () => {
      throw new Error("attempt limit reached");
    });
    const result = await submitGeminiVideoRequest({
      adapter,
      apiKey: "member-secret",
      upstreamModel: "veo-3.1-generate-preview",
      prompt: "test",
      duration: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      effectiveAudio: true,
      onBeforeSend,
    });
    expect(result).toMatchObject({ failure: { kind: "unknown" } });
    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    expect(fetchMediaUpstream).not.toHaveBeenCalled();
  });
});
