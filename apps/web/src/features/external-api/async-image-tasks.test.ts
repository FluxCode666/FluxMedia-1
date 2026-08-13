import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/security/dns-pin", () => ({
  fetchWithDnsPin: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SsrfBlockedError";
    }
  },
}));

import { fetchWithDnsPin } from "@repo/shared/security/dns-pin";
import {
  type GenerationTaskRow,
  postPublicAsyncImageCallback,
  toGenerationImageTaskResponse,
  toVideoGenerationTaskResponse,
  type VideoTaskRow,
  validateCallbackUrl,
} from "./async-image-tasks";

const mockFetchWithDnsPin = vi.mocked(fetchWithDnsPin);

afterEach(() => {
  vi.unstubAllGlobals();
  mockFetchWithDnsPin.mockReset();
});

describe("external async image tasks", () => {
  it("maps a completed generation row to a task response with url + image_url", () => {
    const row: GenerationTaskRow = {
      id: "gen_abc",
      model: "gpt-image-2",
      status: "completed",
      revisedPrompt: "a cat",
      creditsConsumed: "3.15",
      error: null,
      createdAt: new Date("2026-06-22T00:00:00Z"),
      completedAt: new Date("2026-06-22T00:01:00Z"),
    };
    const res = toGenerationImageTaskResponse(
      row,
      "/api/storage/generations/k?sig=x"
    );
    expect(res).toMatchObject({
      id: "gen_abc",
      object: "image",
      status: "completed",
      generation_id: "gen_abc",
      generationId: "gen_abc",
      image_url: "/api/storage/generations/k?sig=x",
      data: [
        { url: "/api/storage/generations/k?sig=x", revised_prompt: "a cat" },
      ],
      credits_consumed: 3.15, // numeric 字符串转 number
      completed_at: "2026-06-22T00:01:00.000Z",
    });
  });

  it("maps pending/failed generations without leaking a url", () => {
    const base: GenerationTaskRow = {
      id: "gen_p",
      model: "gpt-image-2",
      status: "pending",
      revisedPrompt: null,
      creditsConsumed: null,
      error: null,
      createdAt: new Date("2026-06-22T00:00:00Z"),
      completedAt: null,
    };
    const pending = toGenerationImageTaskResponse(base, null);
    expect(pending).toMatchObject({
      status: "processing",
      object: "image.generation",
    });
    expect(pending).not.toHaveProperty("data");
    expect(pending).not.toHaveProperty("image_url");

    const failed = toGenerationImageTaskResponse(
      { ...base, id: "gen_f", status: "failed", error: "boom" },
      null
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: { message: "boom" },
    });
    expect(failed).not.toHaveProperty("data");
  });

  it("maps a completed video generation to a task response with video_url + duration", () => {
    const row: VideoTaskRow = {
      id: "vid_1",
      model: "firefly-sora2-8s-16x9",
      status: "completed",
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "720p",
      generateAudio: false,
      creditsConsumed: "240",
      error: null,
      createdAt: new Date("2026-06-22T00:00:00Z"),
      updatedAt: new Date("2026-06-22T00:03:00Z"),
    };
    const res = toVideoGenerationTaskResponse(
      row,
      "/api/storage/generations/v?sig=x"
    );
    expect(res).toMatchObject({
      id: "vid_1",
      object: "video",
      model: "sora2-8s-16x9",
      status: "completed",
      duration: 8,
      duration_seconds: 8,
      aspectRatio: "16:9",
      aspect_ratio: "16:9",
      resolution: "720p",
      generateAudio: false,
      generate_audio: false,
      generation_id: "vid_1",
      video_url: "/api/storage/generations/v?sig=x",
      data: [{ url: "/api/storage/generations/v?sig=x" }],
      credits_consumed: 240,
      completed_at: "2026-06-22T00:03:00.000Z",
    });
  });

  it("maps queued/in-progress/failed video generations without leaking a url", () => {
    const base: VideoTaskRow = {
      id: "vid_r",
      model: "firefly-sora2-8s-16x9",
      status: "running",
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "720p",
      generateAudio: false,
      creditsConsumed: "240",
      error: null,
      createdAt: new Date("2026-06-22T00:00:00Z"),
      updatedAt: null,
    };
    const queued = toVideoGenerationTaskResponse(
      { ...base, status: "pending", stage: "created" },
      null
    );
    expect(queued).toMatchObject({
      status: "queued",
      object: "video.generation",
    });
    expect(queued).not.toHaveProperty("video_url");
    expect(queued).not.toHaveProperty("data");

    const running = toVideoGenerationTaskResponse(
      { ...base, stage: "polling" },
      null
    );
    expect(running.status).toBe("in_progress");

    const failed = toVideoGenerationTaskResponse(
      { ...base, id: "vid_f", status: "failed", error: "upstream 500" },
      null
    );
    expect(failed).toMatchObject({
      status: "failed",
      error: { message: "upstream 500" },
    });
  });

  it("首次获租前容量等待在回调投影中为 in_progress", () => {
    const response = toVideoGenerationTaskResponse(
      {
        id: "vid-capacity-wait",
        model: "seedance2",
        status: "pending",
        stage: "created",
        capacityWaitDeadlineAt: new Date("2026-08-13T00:02:00.000Z"),
        durationSeconds: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        generateAudio: false,
        creditsConsumed: 0,
        error: null,
        createdAt: new Date("2026-06-22T00:00:00Z"),
        updatedAt: null,
      },
      null
    );

    expect(response.status).toBe("in_progress");
  });

  it("maps legacy uncertain video tasks to in_progress", () => {
    const response = toVideoGenerationTaskResponse(
      {
        id: "vid_legacy",
        model: "seedance2",
        status: "needs_attention",
        stage: "submit_uncertain",
        durationSeconds: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        generateAudio: false,
        creditsConsumed: 20,
        error: null,
        createdAt: new Date("2026-06-22T00:00:00Z"),
        updatedAt: null,
      },
      null
    );

    expect(response.status).toBe("in_progress");
  });

  it("rejects private callback URLs", async () => {
    await expect(
      validateCallbackUrl("https://127.0.0.1/callback")
    ).rejects.toThrow("publicly reachable");
  });

  it("rejects http callback URLs to keep results off plaintext", async () => {
    await expect(
      validateCallbackUrl("http://example.com/callback")
    ).rejects.toThrow("https");
  });

  it("posts callback payloads with the callback marker header", async () => {
    mockFetchWithDnsPin.mockResolvedValueOnce(new Response("ok"));

    await postPublicAsyncImageCallback("https://1.1.1.1/callback", {
      id: "task_123",
      status: "completed",
    });

    expect(mockFetchWithDnsPin).toHaveBeenCalledWith(
      expect.stringContaining("https://1.1.1.1/callback"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Tokens-Callback": "true",
        }),
      })
    );
  });

  it("does not follow a callback redirect into a private address", async () => {
    mockFetchWithDnsPin.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })
    );
    await expect(
      postPublicAsyncImageCallback("https://1.1.1.1/callback", {
        id: "task_123",
      })
    ).rejects.toThrow();

    expect(mockFetchWithDnsPin).toHaveBeenCalledTimes(1);
  });
});
