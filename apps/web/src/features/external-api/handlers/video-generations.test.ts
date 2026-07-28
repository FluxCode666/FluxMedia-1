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
      plan: "pro",
    });
    mocks.ensureInitialized.mockResolvedValue(undefined);
    mocks.validateCallbackUrl.mockImplementation(
      async (value: string) => value
    );
    mocks.invokeOperation.mockResolvedValue({
      taskId: "video-1",
      status: "processing",
    });
  });

  it("缺少 clientRequestId 时拒绝请求", async () => {
    const response = await postExternalVideoGenerations(
      createRequest({ prompt: "test", model: "firefly-veo-2-5s-16x9" }) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("只把领域字段传给 UOL，并把 callback 放入可信上下文", async () => {
    const response = await postExternalVideoGenerations(
      createRequest({
        client_request_id: "client-1",
        prompt: "test",
        model: "firefly-veo-2-5s-16x9",
        callback_url: "https://callback.example.com/video",
      }) as never
    );

    expect(response.status).toBe(202);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.generate",
      {
        clientRequestId: "client-1",
        prompt: "test",
        model: "firefly-veo-2-5s-16x9",
      },
      {
        type: "apiKey",
        credentialKind: "external",
        userId: "user-1",
        apiKeyId: "key-a",
        plan: "pro",
      },
      {
        requestId: "req-1",
        callbacks: {
          videoCompletionUrl: "https://callback.example.com/video",
        },
      }
    );
    const payload = await response.json();
    expect(payload.task_id).toBe("video-1");
  });

  it.each([
    ["generateAudio", true],
    ["generate_audio", false],
  ] as const)("将 %s 原样映射为 UOL generateAudio", async (field, value) => {
    const response = await postExternalVideoGenerations(
      createRequest({
        client_request_id: `client-audio-${String(value)}`,
        prompt: "test",
        model: "firefly-seedance2-15s-9x16-480p",
        [field]: value,
      }) as never
    );

    expect(response.status).toBe(202);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({ generateAudio: value }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("拒绝值冲突的 generateAudio 双别名", async () => {
    const response = await postExternalVideoGenerations(
      createRequest({
        client_request_id: "client-audio-conflict",
        prompt: "test",
        model: "firefly-seedance2-15s-9x16-480p",
        generateAudio: true,
        generate_audio: false,
      }) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });
});
