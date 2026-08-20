/**
 * Gemini 外部视频 handler 契约测试。
 *
 * 使用方：Vitest；验证 Gemini body 只经 UOL 进入任务管线、Operation 名称投影和错误
 * 边界，不访问数据库、账号池或真实上游。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  ensureInitialized: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: class OperationError extends Error {
    readonly httpStatus = 400;
  },
}));
vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: mocks.authenticate,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureInitialized,
}));

import {
  getGeminiVideoOperation,
  postGeminiVideoGeneration,
} from "./gemini-video";

function createRequest(
  body?: unknown,
  headers?: Record<string, string>
): Request {
  return new Request(
    "https://example.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  );
}

describe("Gemini video handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      userId: "user-1",
      apiKeyId: "key-1",
    });
    mocks.ensureInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      taskId: "video-1",
      status: "queued",
      geminiOperationId: "operation-id-1234567890",
    });
  });

  it("将官方 Gemini 创建请求转换为统一 video.generate", async () => {
    const response = await postGeminiVideoGeneration(
      createRequest(
        {
          instances: [{ prompt: "A white cat in neon Tokyo" }],
          parameters: {
            aspectRatio: "16:9",
            resolution: "720p",
            durationSeconds: "8",
          },
        },
        { "idempotency-key": "client-operation-1" }
      ) as never,
      { params: Promise.resolve({ model: "veo-3.1-generate-preview" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "models/veo-3.1-generate-preview/operations/operation-id-1234567890",
      done: false,
    });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({
        clientRequestId: "client-operation-1",
        geminiModel: "veo-3.1-generate-preview",
        geminiOperationId: expect.any(String),
        model: "veo31",
        duration: 8,
      }),
      expect.objectContaining({ type: "apiKey", userId: "user-1" }),
      expect.any(Object)
    );
  });

  it("拒绝 body model 和未知字段，且不触发 UOL", async () => {
    const response = await postGeminiVideoGeneration(
      createRequest({
        model: "veo31",
        instances: [{ prompt: "test" }],
      }) as never,
      { params: Promise.resolve({ model: "veo31" }) }
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("按 Operation name 查询同一任务投影", async () => {
    mocks.invokeOperation.mockResolvedValueOnce({
      name: "models/veo31/operations/operation-id-1234567890",
      done: false,
    });
    const response = await getGeminiVideoOperation(
      new Request("https://example.com") as never,
      {
        params: Promise.resolve({
          model: "veo31",
          operationId: "operation-id-1234567890",
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "models/veo31/operations/operation-id-1234567890",
      done: false,
    });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.getGeminiOperation",
      {
        model: "veo31",
        operationName: "models/veo31/operations/operation-id-1234567890",
      },
      expect.objectContaining({ type: "apiKey", userId: "user-1" }),
      expect.any(Object)
    );
  });
});
