/**
 * 外部视频创建 UOL 适配器单测。
 *
 * 使用方：Vitest；验证强制幂等键、API Key Principal 与 callback 上下文边界，
 * 不触发数据库、Adobe 或对象存储 I/O。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class OperationError extends Error {
    readonly code: string;
    readonly httpStatus: number;
    readonly details?: Record<string, unknown>;

    constructor(
      code: string,
      message: string,
      details?: Record<string, unknown>,
      httpStatus = 400
    ) {
      super(message);
      this.code = code;
      this.details = details;
      this.httpStatus = httpStatus;
    }
  }
  return {
    authenticate: vi.fn(),
    ensureInitialized: vi.fn(),
    invokeOperation: vi.fn(),
    validateCallbackUrl: vi.fn(),
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
vi.mock("@/features/external-api/async-image-tasks", () => ({
  validateCallbackUrl: mocks.validateCallbackUrl,
}));
vi.mock("@/features/external-api/deprecated-governance-fields", () => ({
  createDeprecatedGovernanceFieldResponse: vi.fn(() => null),
}));
vi.mock("@/features/external-api/images", () => ({
  openAIImageError: (message: string, status = 400, code?: string) =>
    Response.json({ error: { message, code: code ?? null } }, { status }),
  toOpenAIErrorPayload: (
    message: string,
    options: {
      type: string;
      code: string;
      status: number;
      details?: Record<string, unknown>;
    }
  ) => ({
    error: {
      message,
      type: options.type,
      code: options.code,
      status: options.status,
      ...(options.details ? { details: options.details } : {}),
    },
  }),
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureInitialized,
}));

import { postExternalVideoGenerations } from "./video-generations";

/** 创建最小外部视频请求。 */
function createRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/videos/generations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-1" },
    body: JSON.stringify(body),
  });
}

describe("postExternalVideoGenerations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      userId: "user-1",
      apiKeyId: "key-a",
    });
    mocks.ensureInitialized.mockResolvedValue(undefined);
    mocks.validateCallbackUrl.mockImplementation(
      async (value: string) => value
    );
    mocks.invokeOperation.mockResolvedValue({
      taskId: "video-1",
      status: "in_progress",
      billing: {
        kind: "snapshot",
        mode: "per_item",
        unit: "item",
        unitPrice: 3,
        durationSeconds: 4,
        quotedCredits: 3,
        actualCredits: 0,
      },
    });
  });

  it.each([
    {
      name: "按秒快照",
      billing: {
        kind: "snapshot",
        mode: "per_second",
        unit: "second",
        unitPrice: 2,
        creditsPerSecond: 2,
        durationSeconds: 4,
        quotedCredits: 8,
        actualCredits: 0,
      },
    },
    {
      name: "按条快照",
      billing: {
        kind: "snapshot",
        mode: "per_item",
        unit: "item",
        unitPrice: 3,
        durationSeconds: 4,
        quotedCredits: 3,
        actualCredits: 0,
      },
    },
    {
      name: "legacy 账单",
      billing: {
        kind: "legacy",
        mode: "per_second",
        unit: "second",
        unitPrice: null,
        creditsPerSecond: null,
        quotedCredits: null,
        actualCredits: 6,
      },
    },
  ])("创建响应透传 $name", async ({ billing }) => {
    mocks.invokeOperation.mockResolvedValueOnce({
      taskId: "video-billing",
      status: "in_progress",
      billing,
    });

    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-billing",
        prompt: "test",
        model: "veo31",
        duration: 4,
        aspectRatio: "16:9",
        resolution: "1080p",
      }) as never
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ billing });
  });

  it("缺少 clientRequestId 时拒绝请求", async () => {
    const response = await postExternalVideoGenerations(
      createRequest({
        prompt: "test",
        model: "veo31",
        duration: 4,
        aspectRatio: "16:9",
        resolution: "1080p",
      }) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("已持久化但无合格账号时返回 OpenAI 风格失败原因", async () => {
    mocks.invokeOperation.mockResolvedValueOnce({
      taskId: "video-no-account",
      status: "failed",
      billing: {
        kind: "snapshot",
        mode: "per_item",
        unit: "item",
        unitPrice: 3,
        durationSeconds: 5,
        quotedCredits: 3,
        actualCredits: 0,
      },
      error: "当前没有可用生成服务",
    });
    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-no-account",
        prompt: "test",
        model: "seedance2",
        duration: 5,
        aspectRatio: "16:9",
        resolution: "1080p",
      }) as never
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      id: "video-no-account",
      status: "failed",
      error: { message: "当前没有可用生成服务" },
    });
  });

  it("单独使用 camelCase 时把真实模型、独立参数和首帧传给 UOL", async () => {
    const firstFrame = `data:image/png;base64,${Buffer.from("first").toString(
      "base64"
    )}`;
    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-camel",
        prompt: "test",
        model: "veo31",
        duration: 4,
        aspectRatio: "16:9",
        resolution: "1080p",
        quoteToken: "quote-veo31-1080p",
        firstFrame,
        callbackUrl: "https://callback.example.com/video",
      }) as never
    );

    expect(response.status).toBe(202);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.generate",
      {
        clientRequestId: "client-camel",
        prompt: "test",
        model: "veo31",
        duration: 4,
        aspectRatio: "16:9",
        resolution: "1080p",
        quoteToken: "quote-veo31-1080p",
        firstFrame: expect.objectContaining({
          source: "data",
          byteLength: 5,
        }),
      },
      {
        type: "apiKey",
        credentialKind: "external",
        userId: "user-1",
        apiKeyId: "key-a",
      },
      {
        externalRequestId: "req-1",
        callbacks: {
          videoCompletionUrl: "https://callback.example.com/video",
        },
      }
    );
    const payload = await response.json();
    expect(payload).toMatchObject({
      task_id: "video-1",
      model: "veo31",
      duration: 4,
      duration_seconds: 4,
      aspectRatio: "16:9",
      aspect_ratio: "16:9",
      resolution: "1080p",
    });
  });

  it("单独使用 snake_case 时合并为唯一 camelCase UOL 输入", async () => {
    const firstFrame = `data:image/png;base64,${Buffer.from("first").toString(
      "base64"
    )}`;
    const lastFrame = `data:image/png;base64,${Buffer.from("last").toString(
      "base64"
    )}`;
    const response = await postExternalVideoGenerations(
      createRequest({
        client_request_id: "client-snake",
        prompt: "test",
        model: "seedance2-fast",
        duration_seconds: 10,
        aspect_ratio: "9:16",
        resolution: "720p",
        quote_token: "quote-seedance-fast-720p",
        negative_prompt: "rain",
        generate_audio: false,
        first_frame: firstFrame,
        last_frame: lastFrame,
      }) as never
    );

    expect(response.status).toBe(202);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({
        clientRequestId: "client-snake",
        model: "seedance2-fast",
        duration: 10,
        aspectRatio: "9:16",
        resolution: "720p",
        quoteToken: "quote-seedance-fast-720p",
        negativePrompt: "rain",
        generateAudio: false,
        firstFrame: expect.objectContaining({ byteLength: 5 }),
        lastFrame: expect.objectContaining({ byteLength: 4 }),
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("把参考视频和音频 URL 转成统一 UOL 媒体引用", async () => {
    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-reference-media",
        prompt: "保持人物动作和镜头不变",
        model: "seedance2",
        duration: 8,
        aspectRatio: "16:9",
        resolution: "1080p",
        reference_videos: ["https://media.example.com/reference.mp4"],
        reference_audios: ["https://media.example.com/reference.mp3"],
      }) as never
    );

    expect(response.status).toBe(202);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({
        referenceVideos: [
          {
            source: "remote",
            mimeType: "video/mp4",
            url: "https://media.example.com/reference.mp4",
          },
        ],
        referenceAudios: [
          {
            source: "remote",
            mimeType: "audio/mpeg",
            url: "https://media.example.com/reference.mp3",
          },
        ],
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it.each([
    {
      field: "reference_videos",
      value: ["http://media.example.com/reference.mp4"],
    },
    {
      field: "reference_videos",
      value: ["https://media.example.com/reference.png"],
    },
    {
      field: "reference_audios",
      value: [
        "https://media.example.com/reference.wav",
        "https://media.example.com/second.wav",
      ],
    },
  ])("拒绝无效的 $field 参考媒体", async ({ field, value }) => {
    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-invalid-reference-media",
        prompt: "test",
        model: "seedance2",
        duration: 8,
        aspectRatio: "16:9",
        resolution: "1080p",
        [field]: value,
      }) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it.each([
    5,
    "5",
  ])("accepts OpenAI seconds compatibility value %o", async (seconds) => {
    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-seconds",
        prompt: "test",
        model: "seedance2",
        seconds,
        aspectRatio: "16:9",
        resolution: "1080p",
      }) as never
    );

    expect(response.status).toBe(202);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({ duration: 5 }),
      expect.any(Object),
      expect.any(Object)
    );
    expect(await response.json()).not.toHaveProperty("seconds");
  });

  it("完全一致的双别名只向 UOL 传一个规范值", async () => {
    const referenceImage = `data:image/png;base64,${Buffer.from(
      "reference"
    ).toString("base64")}`;
    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-matched",
        client_request_id: "client-matched",
        prompt: "test",
        model: "seedance2",
        duration: 10,
        duration_seconds: 10,
        aspectRatio: "16:9",
        aspect_ratio: "16:9",
        resolution: "1080p",
        quoteToken: "quote-seedance-1080p",
        quote_token: "quote-seedance-1080p",
        generateAudio: true,
        generate_audio: true,
        referenceImages: [referenceImage],
        reference_images: [referenceImage],
      }) as never
    );

    expect(response.status).toBe(202);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({
        clientRequestId: "client-matched",
        duration: 10,
        aspectRatio: "16:9",
        quoteToken: "quote-seedance-1080p",
        generateAudio: true,
        referenceImages: [expect.objectContaining({ byteLength: 9 })],
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it.each([
    ["clientRequestId", { clientRequestId: "a", client_request_id: "b" }],
    ["duration", { duration: 10, duration_seconds: 11 }],
    ["seconds", { duration: 10, seconds: "11" }],
    ["aspectRatio", { aspectRatio: "16:9", aspect_ratio: "9:16" }],
    ["generateAudio", { generateAudio: true, generate_audio: false }],
    ["quoteToken", { quoteToken: "quote-a", quote_token: "quote-b" }],
    [
      "referenceImages",
      {
        referenceImages: ["data:image/png;base64,aW1hZ2U="],
        reference_images: ["data:image/png;base64,b3RoZXI="],
      },
    ],
  ])("拒绝值冲突的 %s 双别名", async (_field, aliases) => {
    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-conflict",
        prompt: "test",
        model: "seedance2",
        duration: 10,
        aspectRatio: "16:9",
        resolution: "1080p",
        ...aliases,
      }) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("陈旧报价以 OpenAI details 返回最新报价", async () => {
    mocks.invokeOperation.mockRejectedValueOnce(
      new mocks.OperationError(
        "conflict",
        "视频报价已更新，请确认最新价格后重试",
        {
          reason: "stale_video_quote",
          currentQuote: {
            kind: "current_quote",
            resolution: "1080p",
            mode: "per_item",
            unit: "item",
            unitPrice: 4,
            quoteToken: "fresh-token",
          },
        },
        409
      )
    );

    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-stale",
        prompt: "test",
        model: "veo31",
        duration: 4,
        aspectRatio: "16:9",
        resolution: "1080p",
        quoteToken: "stale-token",
      }) as never
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "conflict",
        details: {
          reason: "stale_video_quote",
          currentQuote: {
            kind: "current_quote",
            unitPrice: 4,
            quoteToken: "fresh-token",
          },
        },
      },
    });
  });

  it.each([
    ["image", { image: ["data:image/png;base64,aW1hZ2U="] }],
    ["inputImages", { inputImages: [] }],
    ["inputImageRole", { inputImageRole: "frame" }],
    ["input_image_role", { input_image_role: "reference" }],
  ])("拒绝旧输入字段 %s", async (_field, legacyInput) => {
    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-legacy",
        prompt: "test",
        model: "seedance2",
        duration: 10,
        aspectRatio: "16:9",
        resolution: "1080p",
        ...legacyInput,
      }) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    1.5,
    "",
    "01",
    "1.5",
    "five",
  ])("rejects invalid seconds compatibility value %o", async (seconds) => {
    const response = await postExternalVideoGenerations(
      createRequest({
        clientRequestId: "client-invalid-seconds",
        prompt: "test",
        model: "seedance2",
        seconds,
        aspectRatio: "16:9",
        resolution: "1080p",
      }) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });
});
