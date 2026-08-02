/**
 * 外部图片生成与编辑传输契约测试。
 *
 * 使用方：Vitest；证明 JSON 文生图与 multipart 图生图只规范公开输入、构造 API Key
 * Principal 并汇入统一 image.generate UOL，不接触供应商路径、账号或适配脚本。
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateExternalApiRequest: vi.fn(),
  canUsePlanCapability: vi.fn(),
  filesToMediaInputReferences: vi.fn(),
  getPlanLimits: vi.fn(),
  getPlanUploadLimits: vi.fn(),
  getUserPlan: vi.fn(),
  invokeImageGenerationOperation: vi.fn(),
  uploadModerationImages: vi.fn(),
}));

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: <T>(handler: T) => handler,
}));

vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  MAX_PLAN_BATCH_COUNT: 16,
  canUsePlanCapability: mocks.canUsePlanCapability,
  getPlanLimits: mocks.getPlanLimits,
}));

vi.mock("@repo/shared/subscription/services/upload-limits", () => ({
  getPlanUploadLimits: mocks.getPlanUploadLimits,
}));

vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: mocks.getUserPlan,
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
  invokeImageGenerationOperation: mocks.invokeImageGenerationOperation,
}));

import { postExternalImageEdits } from "./image-edits";
import { postExternalImageGenerations } from "./image-generations";

/** 构造带固定外部请求标识的文生图 JSON 请求。 */
function createGenerationRequest(): NextRequest {
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
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    }),
  });
}

/** 构造同时包含源图与 mask 的图生图 multipart 请求。 */
function createEditRequest(): NextRequest {
  const formData = new FormData();
  formData.set("prompt", "synthetic edit");
  formData.set("model", "gpt-image-2");
  formData.set("size", "1024x1024");
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
      plan: "pro",
    });
    mocks.canUsePlanCapability.mockResolvedValue(true);
    mocks.getUserPlan.mockResolvedValue({ plan: "pro" });
    mocks.getPlanLimits.mockResolvedValue({
      imageGenerationConcurrency: 2,
      maxBatchCount: 4,
      maxEditImages: 12,
    });
    mocks.getPlanUploadLimits.mockResolvedValue({
      maxFileSizeBytes: 10 * 1024 * 1024,
      maxUploadBytes: 20 * 1024 * 1024,
    });
    mocks.uploadModerationImages.mockResolvedValue([]);
    mocks.filesToMediaInputReferences.mockImplementation(
      async (files: readonly File[]) =>
        files.map((file) => ({
          source: "storage",
          storageBucket: "test-inputs",
          storageKey: file.name,
          mediaType: file.type,
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
        plan: "pro",
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
            mediaType: "image/png",
          }),
        ],
        mask: expect.objectContaining({
          storageKey: "mask.png",
          mediaType: "image/png",
        }),
      }),
      {
        type: "apiKey",
        credentialKind: "external",
        userId: "user-1",
        apiKeyId: "api-key-1",
        plan: "pro",
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
});
