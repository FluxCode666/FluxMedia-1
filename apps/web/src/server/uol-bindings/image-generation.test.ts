/**
 * 图片 UOL late binding 的 DB-free 契约测试。
 *
 * 职责：验证 generate/edit/mask 三个联合分支、Principal 身份、媒体加载和局部
 * 流回调真实透传到唯一图片管线。
 * 使用方：apps/web Vitest 门禁；所有 I/O 通过依赖注入替换。
 */

import type { OperationContext, Principal } from "@repo/shared/uol";
import { describe, expect, it, vi } from "vitest";
import type { RedisImageGenerationAdmissionAcquisition } from "@/features/image-generation/redis-image-generation-slots";

import {
  executeImageGenerateBinding,
  type ImageGenerationBindingDependencies,
} from "./image-generation";

const userPrincipal = {
  type: "user",
  userId: "user-1",
  role: "user",
} satisfies Principal;

const apiKeyPrincipal = {
  type: "apiKey",
  credentialKind: "external",
  userId: "user-1",
  apiKeyId: "key-1",
  plan: "pro",
} satisfies Principal;

const mcpPrincipal = {
  type: "apiKey",
  credentialKind: "mcp",
  userId: "user-1",
  apiKeyId: "mcp-key-1",
  plan: "pro",
} satisfies Principal;

/** 构造不执行额外权限判断的测试 OperationContext。 */
function operationContext(
  callbacks?: Record<string, unknown>
): OperationContext {
  return {
    requestId: "request-1",
    callbacks,
    assertOwnership: vi.fn(),
  };
}

/** 构造可观测的图片 binding 依赖桩。 */
function dependencies(): {
  value: ImageGenerationBindingDependencies;
  load: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  getLimits: ReturnType<typeof vi.fn>;
  acquireAdmission: ReturnType<typeof vi.fn>;
  releaseAdmission: ReturnType<typeof vi.fn>;
} {
  const load = vi.fn(async () => [
    { data: Buffer.from("image"), type: "image/png" },
    { data: Buffer.from("mask"), type: "image/png" },
  ]);
  const run = vi.fn(async () => ({
    generationId: "generation-1",
    imageUrl: "https://cdn.example.com/image.png",
    creditsConsumed: 2,
    model: "gpt-image-2",
  }));
  const getLimits = vi.fn(async () => ({
    limit: 20,
    effectiveSource: "system_default" as const,
  }));
  const acquireAdmission = vi.fn(
    async (): Promise<RedisImageGenerationAdmissionAcquisition> => ({
      status: "acquired",
      lease: {
        token: "admission-token",
        userKey: "hashed-user-key",
        expiresAt: Date.now() + 60_000,
      },
    })
  );
  const releaseAdmission = vi.fn(async () => undefined);
  return {
    value: {
      loadMediaInputs: load,
      runImageGenerationForUser: run,
      getMediaLimitsForUser: getLimits,
      acquireImageGenerationAdmission: acquireAdmission,
      releaseImageGenerationAdmission: releaseAdmission,
    },
    load,
    run,
    getLimits,
    acquireAdmission,
    releaseAdmission,
  };
}

const dataReference = {
  source: "data" as const,
  mimeType: "image/png" as const,
  base64: "aW1hZ2U=",
  byteLength: 5,
};

describe("executeImageGenerateBinding", () => {
  it("在加载编辑媒体前取得准入槽，用户超限时立即返回 429", async () => {
    const deps = dependencies();
    deps.acquireAdmission.mockResolvedValueOnce({
      status: "blocked",
      reason: "user",
    });

    await expect(
      executeImageGenerateBinding(
        {
          operation: "edit",
          prompt: "改成夜景",
          model: "gpt-image-2",
          generationId: "generation-limit-before-load",
          images: [dataReference],
        },
        userPrincipal,
        operationContext(),
        deps.value
      )
    ).rejects.toMatchObject({
      code: "concurrency_limit_exceeded",
      httpStatus: 429,
      details: {
        limit: 20,
        effectiveSource: "system_default",
        scope: "user",
      },
    });
    expect(deps.load).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.releaseAdmission).not.toHaveBeenCalled();
  });

  it("generate 从 API Key Principal 透传身份与局部流回调", async () => {
    const deps = dependencies();
    const onPartialImage = vi.fn();
    const result = await executeImageGenerateBinding(
      {
        operation: "generate",
        prompt: "一只猫",
        model: "gpt-image-2",
        generationId: "generation-1",
      },
      apiKeyPrincipal,
      operationContext({ onPartialImage }),
      deps.value
    );

    expect(deps.load).not.toHaveBeenCalled();
    expect(deps.run).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "generate",
        userId: "user-1",
        apiKeyId: "key-1",
        prompt: "一只猫",
      }),
      expect.objectContaining({ onPartialImage: expect.any(Function) })
    );
    const callbacks = deps.run.mock.calls[0]?.[1];
    await callbacks?.onPartialImage?.({ imageUrl: "partial" });
    expect(onPartialImage).toHaveBeenCalledWith({ imageUrl: "partial" });
    expect(result).toMatchObject({
      generationId: "generation-1",
      images: [{ url: "https://cdn.example.com/image.png" }],
      creditsUsed: 2,
    });
  });

  it("edit 加载全部图片并以 edit 模式调用唯一管线", async () => {
    const deps = dependencies();
    await executeImageGenerateBinding(
      {
        operation: "edit",
        prompt: "改成夜景",
        model: "gpt-image-2",
        generationId: "generation-2",
        images: [dataReference],
      },
      userPrincipal,
      operationContext(),
      deps.value
    );

    expect(deps.load).toHaveBeenCalledWith({
      userId: "user-1",
      references: [dataReference],
    });
    expect(deps.run).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "edit",
        images: [
          expect.objectContaining({
            data: Buffer.from("image"),
            name: "image-1.png",
          }),
        ],
      }),
      undefined
    );
    expect(deps.releaseAdmission).toHaveBeenCalledTimes(1);
  });

  it("编辑媒体加载失败时释放已取得的用户准入槽", async () => {
    const deps = dependencies();
    deps.load.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      executeImageGenerateBinding(
        {
          operation: "edit",
          prompt: "改成夜景",
          model: "gpt-image-2",
          generationId: "generation-load-failed",
          images: [dataReference],
        },
        userPrincipal,
        operationContext(),
        deps.value
      )
    ).rejects.toThrow("storage unavailable");
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.releaseAdmission).toHaveBeenCalledTimes(1);
  });

  it("edit 保留可信存储引用，避免图片管线再次转存", async () => {
    const deps = dependencies();
    deps.load.mockResolvedValueOnce([
      {
        data: Buffer.from("stored-image"),
        type: "image/png",
        storageKey: "user-1/requests/input.png",
        storageBucket: "generations",
      },
    ]);
    const storageReference = {
      source: "storage" as const,
      mimeType: "image/png" as const,
      storageKey: "user-1/requests/input.png",
      storageBucket: "generations",
      byteLength: 12,
    };

    await executeImageGenerateBinding(
      {
        operation: "edit",
        prompt: "改成夜景",
        model: "gpt-image-2",
        generationId: "generation-storage",
        images: [storageReference],
      },
      userPrincipal,
      operationContext(),
      deps.value
    );

    expect(deps.run).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [
          expect.objectContaining({
            storageKey: "user-1/requests/input.png",
            storageBucket: "generations",
          }),
        ],
      }),
      undefined
    );
  });

  it("MCP Key 不冒充外部 API Key 进入号池绑定分组", async () => {
    const deps = dependencies();
    await executeImageGenerateBinding(
      {
        operation: "generate",
        prompt: "一只猫",
        model: "gpt-image-2",
        generationId: "generation-3",
      },
      mcpPrincipal,
      operationContext(),
      deps.value
    );

    expect(deps.run).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKeyId: "mcp-key-1" }),
      undefined
    );
  });

  it("mask 在一次总量校验中加载图片与蒙版并正确拆分", async () => {
    const deps = dependencies();
    const maskReference = {
      ...dataReference,
      base64: "bWFzaw==",
      byteLength: 4,
    };
    await executeImageGenerateBinding(
      {
        operation: "mask",
        prompt: "只替换蒙版区域",
        model: "gpt-image-2",
        generationId: "generation-4",
        images: [dataReference],
        mask: maskReference,
      },
      userPrincipal,
      operationContext(),
      deps.value
    );

    expect(deps.load).toHaveBeenCalledWith({
      userId: "user-1",
      references: [dataReference, maskReference],
    });
    expect(deps.run).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "edit",
        images: [expect.objectContaining({ name: "image-1.png" })],
        mask: expect.objectContaining({ name: "mask-1.png" }),
      }),
      undefined
    );
  });

  it("保留并发超限的 UOL code、429 和安全 details", async () => {
    const deps = dependencies();
    deps.run.mockResolvedValueOnce({
      error: "用户同时进行的生图任务已达到上限 20",
      errorCode: "concurrency_limit_exceeded",
      errorDetails: {
        limit: 20,
        effectiveSource: "system_default",
        scope: "user",
      },
      generationId: "generation-limit",
    });

    await expect(
      executeImageGenerateBinding(
        {
          operation: "generate",
          prompt: "一只猫",
          model: "gpt-image-2",
          generationId: "generation-limit",
        },
        userPrincipal,
        operationContext(),
        deps.value
      )
    ).rejects.toMatchObject({
      code: "concurrency_limit_exceeded",
      httpStatus: 429,
      details: {
        limit: 20,
        effectiveSource: "system_default",
        scope: "user",
      },
    });
  });
});
