/**
 * 图片 UOL 站内调用适配器测试。
 *
 * 职责：证明 HTTP 传输只调用 `image.generate`，并正确透传 Principal、幂等键与局部
 * 流回调；测试不加载数据库或真实图片管线。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { invokeImageGenerationOperation } from "./uol-client";

describe("invokeImageGenerationOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      generationId: "generation-1",
      images: [
        {
          url: "/api/storage/image.png",
          size: "1024x1024",
          outputRole: "final",
        },
      ],
      creditsUsed: 2,
      model: "gpt-image-2",
      size: "1024x1024",
    });
  });

  it("经 UOL 调用并把 URL 输出映射给既有响应编码器", async () => {
    const onPartialImage = vi.fn();
    const principal = {
      type: "apiKey" as const,
      credentialKind: "external" as const,
      userId: "user-1",
      apiKeyId: "key-1",
      plan: "pro",
    };

    const result = await invokeImageGenerationOperation(
      {
        operation: "generate",
        prompt: "海边日落",
        generationId: "generation-1",
      },
      principal,
      { onPartialImage },
      "request-1"
    );

    expect(mocks.ensureUolInitialized).toHaveBeenCalledTimes(1);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({ generationId: "generation-1" }),
      principal,
      {
        requestId: "request-1",
        callbacks: { onPartialImage },
      }
    );
    expect(result).toMatchObject({
      generationId: "generation-1",
      imageUrl: "/api/storage/image.png",
      imageOutputs: [{ imageUrl: "/api/storage/image.png" }],
      creditsConsumed: 2,
      model: "gpt-image-2",
    });
  });
});
