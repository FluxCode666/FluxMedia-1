/**
 * 外部视频查询 UOL 适配器单测。
 *
 * 使用方：Vitest；验证查询始终携带精确 apiKeyId，并完全委托 UOL 做持久归属校验。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class OperationError extends Error {
    readonly code: string;
    readonly httpStatus: number;

    constructor(code: string, message: string, httpStatus = 400) {
      super(message);
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }
  return {
    authenticate: vi.fn(),
    ensureInitialized: vi.fn(),
    invokeOperation: vi.fn(),
    OperationError,
  };
});

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: (handler: unknown) => handler,
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: mocks.OperationError,
}));
vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: mocks.authenticate,
}));
vi.mock("@/features/external-api/images", () => ({
  openAIImageError: (message: string, status = 400, code?: string) =>
    Response.json({ error: { message, code: code ?? null } }, { status }),
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureInitialized,
}));

import { getExternalVideoTask } from "./video-tasks";

describe("getExternalVideoTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      userId: "user-1",
      apiKeyId: "key-a",
    });
    mocks.ensureInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      taskId: "video-1",
      status: "completed",
      model: "seedance2",
      duration: 10,
      aspectRatio: "16:9",
      resolution: "1080p",
      generateAudio: false,
      input: { mode: "references", count: 2 },
      videoUrl: "https://example.com/video.mp4",
      createdAt: "2026-07-26T00:00:00.000Z",
      completedAt: "2026-07-26T00:01:00.000Z",
    });
  });

  it("使用 userId 与 apiKeyId 组成的 Principal 查询持久任务", async () => {
    const request = new Request("https://example.com/v1/videos/video-1", {
      headers: { "x-request-id": "req-2" },
    });
    const response = await getExternalVideoTask(request as never, {
      params: Promise.resolve({ taskId: "video-1" }),
    });

    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.getStatus",
      { taskId: "video-1" },
      {
        type: "apiKey",
        credentialKind: "external",
        userId: "user-1",
        apiKeyId: "key-a",
      },
      { externalRequestId: "req-2" }
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.video_url).toBe("https://example.com/video.mp4");
    expect(payload).toMatchObject({
      model: "seedance2",
      duration: 10,
      duration_seconds: 10,
      aspectRatio: "16:9",
      aspect_ratio: "16:9",
      resolution: "1080p",
      generateAudio: false,
      generate_audio: false,
      input: { mode: "references", count: 2 },
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /storageKey|storageBucket|referenceImages|firstFrame|lastFrame/
    );
  });

  it("将 UOL 的归属失败映射为 404", async () => {
    mocks.invokeOperation.mockRejectedValue(
      new mocks.OperationError("not_found", "Video task not found", 404)
    );
    const response = await getExternalVideoTask(
      new Request("https://example.com/v1/videos/video-2") as never,
      { params: Promise.resolve({ taskId: "video-2" }) }
    );

    expect(response.status).toBe(404);
  });
});
