/**
 * 外部图片生成与编辑传输契约测试。
 *
 * 使用方：Vitest；证明 JSON 文生图与 multipart 图生图只规范公开输入、构造 API Key
 * Principal 并汇入统一 image.generate UOL，不接触供应商路径、账号或适配脚本。
 */

import type { ImageEnqueueAsyncInput } from "@repo/shared/uol/operations/image-generation";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateExternalApiRequest: vi.fn(),
  filesToMediaInputReferences: vi.fn(),
  getMediaLimitDefaults: vi.fn(),
  invokeImageEnqueueAsyncOperation: vi.fn(),
  invokeImageGenerationOperation: vi.fn(),
  uploadModerationImages: vi.fn(),
}));

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: <T>(handler: T) => handler,
}));

vi.mock("@repo/shared/image-generation/media-limit-service", () => ({
  getMediaLimitDefaults: mocks.getMediaLimitDefaults,
}));

vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: mocks.authenticateExternalApiRequest,
}));

vi.mock("@/features/external-api/deprecated-governance-fields", () => ({
  createDeprecatedGovernanceFieldResponse: vi.fn(() => null),
}));

vi.mock("@/features/external-api/images", () => ({
  IMAGE_JSON_KEEP_ALIVE_INITIAL_WAIT_MS: 0,
  createExternalImageStreamResponse: vi.fn(),
  createJsonKeepAliveResponse: async (
    run: () => Promise<unknown>
  ): Promise<Response> => Response.json(await run()),
  getExternalFinalImageOutputs: vi.fn(() => []),
  getImageBase64: vi.fn(),
  getPublicImageUrl: vi.fn(),
  openAIImageError: (message: string, status = 400, code?: string) =>
    Response.json(
      { error: { message, type: "invalid_request_error", code: code ?? null } },
      { status }
    ),
  toExternalErrorStreamData: vi.fn(),
  toLoggedOpenAIErrorPayload: vi.fn(),
  toOpenAIErrorPayload: vi.fn(),
  toOpenAIImagesResponse: async (
    _request: Request,
    results: readonly unknown[]
  ) => ({ object: "list", data: results }),
  wantsImageStreamResponse: vi.fn(() => false),
}));

vi.mock("@/features/image-generation/request-utils", () => ({
  DEFAULT_MAX_IMAGE_BYTES: 10 * 1024 * 1024,
  filesToMediaInputReferences: mocks.filesToMediaInputReferences,
  formatMegabytes: (bytes: number) => `${bytes / 1024 / 1024} MB`,
  getTotalUploadSize: vi.fn(() => 12),
  uploadModerationImages: mocks.uploadModerationImages,
  validateImageFile: vi.fn(),
}));

vi.mock("@/features/image-generation/uol-client", () => ({
  invokeImageEnqueueAsyncOperation: mocks.invokeImageEnqueueAsyncOperation,
  invokeImageGenerationOperation: mocks.invokeImageGenerationOperation,
}));

import { postExternalImageEdits } from "./image-edits";
import { postExternalImageGenerations } from "./image-generations";

/** 构造带固定外部请求标识的文生图 JSON 请求。 */
function createGenerationRequest(
  useAsync = false,
  overrides: Record<string, unknown> = {}
): NextRequest {
  return new NextRequest("https://app.example.test/v1/images/generations", {
    method: "POST",
    headers: {
      authorization: "Bearer external-key",
      "content-type": "application/json",
      "x-request-id": "request-generate-1",
    },
    body: JSON.stringify({
      prompt: "synthetic prompt",
      model: "gpt-image-2",
      size: "1024x1024",
      response_format: "b64_json",
      ...(useAsync ? { async: true } : {}),
      ...overrides,
    }),
  });
}

/** 构造同时包含源图与 mask 的图生图 multipart 请求。 */
function createEditRequest(useAsync = false, n?: number): NextRequest {
  const formData = new FormData();
  formData.set("prompt", "synthetic edit");
  formData.set("model", "gpt-image-2");
  formData.set("size", "1024x1024");
  if (useAsync) formData.set("async", "true");
  if (n !== undefined) formData.set("n", String(n));
  formData.set(
    "image",
    new File(["source"], "source.png", { type: "image/png" })
  );
  formData.set("mask", new File(["mask"], "mask.png", { type: "image/png" }));
  return new NextRequest("https://app.example.test/v1/images/edits", {
    method: "POST",
    headers: {
      authorization: "Bearer external-key",
      "x-request-id": "request-edit-1",
    },
    body: formData,
  });
}

describe("external image generation transport contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateExternalApiRequest.mockResolvedValue({
      userId: "user-1",
      apiKeyId: "api-key-1",
    });
    mocks.getMediaLimitDefaults.mockResolvedValue({
      maxFileSizeBytes: 10 * 1024 * 1024,
      maxUploadSizeBytes: 20 * 1024 * 1024,
      maxEditReferenceImages: 12,
    });
    mocks.uploadModerationImages.mockImplementation(
      async (_userId: string, _batchId: string, files: readonly File[]) =>
        files.map((file, index) => ({
          bucket: "test-inputs",
          key: `${index}-${file.name}`,
          url: `https://storage.example.test/${index}-${file.name}`,
        }))
    );
    mocks.filesToMediaInputReferences.mockImplementation(
      async (files: readonly File[]) =>
        files.map((file) => ({
          source: "storage",
          storageBucket: "test-inputs",
          storageKey: file.name,
          mimeType: file.type,
          byteLength: file.size,
        }))
    );
    mocks.invokeImageGenerationOperation.mockResolvedValue({
      generationId: "generation-1",
      model: "gpt-image-2",
      size: "1024x1024",
      creditsConsumed: 1,
      imageBase64: "c3ludGhldGlj",
    });
    mocks.invokeImageEnqueueAsyncOperation.mockImplementation(
      async (operationInput: ImageEnqueueAsyncInput) => {
        const generationInput = operationInput.generationInput;
        return {
          taskId: operationInput.taskId,
          model: generationInput.model,
          operation: generationInput.operation,
          status: "queued",
          generationId: generationInput.generationId,
          responseFormat: operationInput.responseFormat,
          createdAt: "2026-08-04T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          error: null,
        };
      }
    );
  });

  it("文生图只向 UOL 传平台真实模型和 API Key Principal", async () => {
    const response = await postExternalImageGenerations(
      createGenerationRequest()
    );

    expect(response.status).toBe(200);
    expect(mocks.invokeImageGenerationOperation).toHaveBeenCalledTimes(1);
    expect(mocks.invokeImageGenerationOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "generate",
        generationId: expect.any(String),
        prompt: "synthetic prompt",
        model: "gpt-image-2",
        size: "1024x1024",
      }),
      {
        type: "apiKey",
        credentialKind: "external",
        userId: "user-1",
        apiKeyId: "api-key-1",
      },
      undefined,
      "request-generate-1"
    );
    const [operationInput] =
      mocks.invokeImageGenerationOperation.mock.calls[0] ?? [];
    expect(operationInput).not.toHaveProperty("baseUrl");
    expect(operationInput).not.toHaveProperty("upstreamModelId");
    expect(operationInput).not.toHaveProperty("requestScript");
    expect(operationInput).not.toHaveProperty("responseScript");
  });

  it.each([1, 2])("文生图显式 n=%s 时严格返回 400", async (n) => {
    const response = await postExternalImageGenerations(
      createGenerationRequest(false, { n })
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
  });

  it("图生图把源图和 mask 规范为媒体引用后进入同一 UOL", async () => {
    const response = await postExternalImageEdits(createEditRequest());

    expect(response.status).toBe(200);
    expect(mocks.invokeImageGenerationOperation).toHaveBeenCalledTimes(1);
    expect(mocks.invokeImageGenerationOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "mask",
        generationId: expect.any(String),
        prompt: "synthetic edit",
        model: "gpt-image-2",
        size: "1024x1024",
        images: [
          expect.objectContaining({
            storageKey: "source.png",
            mimeType: "image/png",
          }),
        ],
        mask: expect.objectContaining({
          storageKey: "mask.png",
          mimeType: "image/png",
        }),
      }),
      {
        type: "apiKey",
        credentialKind: "external",
        userId: "user-1",
        apiKeyId: "api-key-1",
      },
      undefined,
      "request-edit-1"
    );
    const [operationInput] =
      mocks.invokeImageGenerationOperation.mock.calls[0] ?? [];
    expect(operationInput).not.toHaveProperty("baseUrl");
    expect(operationInput).not.toHaveProperty("apiKey");
    expect(operationInput).not.toHaveProperty("apiUpstreamAdapter");
  });

  it.each([1, 2])("multipart 编辑显式 n=%s 时严格返回 400", async (n) => {
    const response = await postExternalImageEdits(createEditRequest(false, n));

    expect(response.status).toBe(400);
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
  });

  it.each([1, 2])("JSON 编辑显式 n=%s 时严格返回 400", async (n) => {
    const response = await postExternalImageEdits(
      new NextRequest("https://app.example.test/v1/images/edits", {
        method: "POST",
        headers: {
          authorization: "Bearer external-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ n }),
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
  });

  it("异步文生图只持久创建任务并由 MQ 执行，不启动请求内 Promise", async () => {
    const response = await postExternalImageGenerations(
      createGenerationRequest(true)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: expect.stringMatching(/^task_/),
      status: "processing",
      object: "image.generation",
    });
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
    expect(mocks.invokeImageEnqueueAsyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: expect.stringMatching(/^task_/),
        generationInput: expect.objectContaining({
          operation: "generate",
          generationId: expect.any(String),
        }),
        responseFormat: "b64_json",
      }),
      expect.objectContaining({ apiKeyId: "api-key-1" }),
      "request-generate-1"
    );
  });

  it("异步编辑先把源图和 mask 全部转存为 storage 引用再创建任务", async () => {
    const response = await postExternalImageEdits(createEditRequest(true));

    expect(response.status).toBe(200);
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
    expect(mocks.uploadModerationImages).toHaveBeenCalledTimes(2);
    expect(mocks.invokeImageEnqueueAsyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        generationInput: expect.objectContaining({
          operation: "mask",
          images: [expect.objectContaining({ source: "storage" })],
          mask: expect.objectContaining({ source: "storage" }),
        }),
      }),
      expect.objectContaining({ apiKeyId: "api-key-1" }),
      "request-edit-1"
    );
  });

  it("异步编辑在对象存储不可用时明确失败且不持久化 base64", async () => {
    mocks.uploadModerationImages.mockResolvedValue(undefined);

    const response = await postExternalImageEdits(createEditRequest(true));

    expect(response.status).toBe(503);
    expect(mocks.invokeImageEnqueueAsyncOperation).not.toHaveBeenCalled();
  });
});
