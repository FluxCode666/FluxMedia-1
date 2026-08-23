/**
 * Seedance/Ark 视频适配器契约测试。
 *
 * 使用方：Vitest；验证该模式使用独立长任务路径和 content 请求结构，不会落入 custom
 * 脚本执行器。
 */

import type { ApiUpstreamAdapterDraft } from "@repo/shared/image-backend/api-upstream-adaptation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchMediaUpstream: vi.fn() }));
vi.mock("@/features/image-backend-pool/media-upstream-fetch", () => ({
  fetchMediaUpstream: mocks.fetchMediaUpstream,
}));

import {
  pollSeedanceVideoRequest,
  submitSeedanceVideoRequest,
} from "./seedance-video";

const adapter: ApiUpstreamAdapterDraft = {
  baseUrl: "https://ark.example.com",
  useStream: false,
  videoSubmissionRetryCount: 2,
  videoProtocolMode: "seedance",
  videoInputCapabilities: { referenceVideos: false, referenceAudios: false },
  modelMappings: [],
  authentication: { mode: "bearer" },
  credentialScope: "https://ark.example.com|bearer",
  operations: {
    "images.generate": { path: "", requestScript: "", responseScript: "" },
    "images.generate.query": {
      path: "",
      requestScript: "",
      responseScript: "",
    },
    "images.edit": { path: "", requestScript: "", responseScript: "" },
    "images.edit.query": { path: "", requestScript: "", responseScript: "" },
    "videos.generate": {
      path: "/wrong",
      requestScript: "return {};",
      responseScript: "",
    },
    "videos.query": {
      path: "/wrong/{task_id}",
      requestScript: "return {};",
      responseScript: "",
    },
  },
};

describe("Seedance video upstream adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the Seedance content task protocol and member bearer", async () => {
    mocks.fetchMediaUpstream.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "task-1", status: "queued" }), {
        status: 200,
      })
    );
    const result = await submitSeedanceVideoRequest({
      adapter,
      apiKey: "member-secret",
      upstreamModel: "doubao-seedance-1-0-pro",
      prompt: "A paper crane flying over a lake",
      duration: 5,
      aspectRatio: "16:9",
      resolution: "720p",
      effectiveAudio: false,
      referenceVideos: ["https://oss.example.test/reference.mp4"],
      referenceAudios: ["https://oss.example.test/reference.mp3"],
    });

    expect(result).toMatchObject({
      status: "pending",
      upstreamJobId: "task-1",
    });
    const [url, init] = mocks.fetchMediaUpstream.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://ark.example.com/api/v3/contents/generations/tasks"
    );
    expect(init.headers).toMatchObject({
      Authorization: "Bearer member-secret",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "doubao-seedance-1-0-pro",
      ratio: "16:9",
      duration: 5,
      resolution: "720p",
      content: [{ type: "text", text: "A paper crane flying over a lake" }],
      reference_videos: ["https://oss.example.test/reference.mp4"],
      reference_audios: ["https://oss.example.test/reference.mp3"],
    });
  });

  it("parses content video_url on the fixed task query", async () => {
    mocks.fetchMediaUpstream.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "task-1",
          status: "succeeded",
          content: [
            {
              type: "video_url",
              video_url: { url: "https://cdn.example/video.mp4" },
            },
          ],
        }),
        { status: 200 }
      )
    );
    const result = await pollSeedanceVideoRequest({
      adapter,
      apiKey: "member-secret",
      upstreamJobId: "task-1",
    });
    expect(result).toMatchObject({
      status: "completed",
      videoUrl: "https://cdn.example/video.mp4",
    });
    expect(mocks.fetchMediaUpstream.mock.calls[0]?.[0]).toBe(
      "https://ark.example.com/api/v3/contents/generations/tasks/task-1"
    );
  });

  it("reserves the submission attempt before sending", async () => {
    const onBeforeSend = vi.fn(async () => {
      throw new Error("attempt limit reached");
    });
    const result = await submitSeedanceVideoRequest({
      adapter,
      apiKey: "member-secret",
      upstreamModel: "doubao-seedance-1-0-pro",
      prompt: "test",
      duration: 5,
      aspectRatio: "16:9",
      resolution: "720p",
      effectiveAudio: false,
      onBeforeSend,
    });
    expect(result).toMatchObject({ failure: { kind: "unknown" } });
    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    expect(mocks.fetchMediaUpstream).not.toHaveBeenCalled();
  });
});
