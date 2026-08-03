/**
 * 持久图片异步任务公开响应测试。
 *
 * 职责：验证进行中不读取 generation，完成态按 URL/base64 聚合，且数据库脏行和
 * 跨用户产物 fail-closed。
 */
import { describe, expect, it, vi } from "vitest";

import type { ImageAsyncTaskRecord } from "@/features/image-generation/image-async-task-repository";
import {
  buildImageAsyncTaskPublicResponse,
  type ImageAsyncTaskResponseDependencies,
} from "./image-async-task-response";

const NOW = new Date("2026-08-04T00:00:00.000Z");

/** 创建公开响应测试使用的持久任务。 */
function createTask(
  overrides: Partial<ImageAsyncTaskRecord> = {}
): ImageAsyncTaskRecord {
  return {
    id: "task_123",
    userId: "user-1",
    apiKeyId: "key-1",
    plan: "pro",
    operation: "generate",
    generationInputs: [
      {
        operation: "generate",
        prompt: "test",
        model: "gpt-image-2",
        generationId: "generation-1",
      },
    ],
    generationIds: ["generation-1"],
    responseFormat: "url",
    callbackUrl: null,
    status: "queued",
    attemptCount: 0,
    claimToken: null,
    claimExpiresAt: null,
    error: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 创建可观察 generation、存储和站点 URL 的响应依赖。 */
function createDependencies(
  generationOverrides: Record<string, unknown> = {}
): ImageAsyncTaskResponseDependencies {
  return {
    loadGeneration: vi.fn(async (id) => ({
      id,
      userId: "user-1",
      model: "gpt-image-2",
      status: "completed" as const,
      revisedPrompt: "revised",
      storageKey: `user-1/${id}.png`,
      storageBucket: "generations",
      creditsConsumed: "1.25",
      error: null,
      ...generationOverrides,
    })),
    loadStorageObject: vi.fn(async () => Buffer.from("image-bytes")),
    getPublicBaseUrl: vi.fn(async () => "https://media.example.com"),
  };
}

describe("image async task public response", () => {
  it("queued 任务兼容映射为 processing 且不读取 generation", async () => {
    const dependencies = createDependencies();
    await expect(
      buildImageAsyncTaskPublicResponse(createTask(), dependencies)
    ).resolves.toMatchObject({
      id: "task_123",
      object: "image.generation",
      status: "processing",
      generation_id: "generation-1",
    });
    expect(dependencies.loadGeneration).not.toHaveBeenCalled();
  });

  it("完成任务签发绝对 URL 并聚合积分", async () => {
    process.env.BETTER_AUTH_SECRET = "test-storage-signing-secret";
    const dependencies = createDependencies();
    await expect(
      buildImageAsyncTaskPublicResponse(
        createTask({ status: "completed", completedAt: NOW }),
        dependencies
      )
    ).resolves.toMatchObject({
      object: "image",
      status: "completed",
      data: [
        {
          url: expect.stringMatching(
            /^https:\/\/media\.example\.com\/api\/storage\/generations\//
          ),
          revised_prompt: "revised",
        },
      ],
      credits_consumed: 1.25,
      usage: null,
    });
  });

  it("b64_json 从对象存储读取字节而不构造 URL", async () => {
    const dependencies = createDependencies();
    const response = await buildImageAsyncTaskPublicResponse(
      createTask({
        status: "completed",
        completedAt: NOW,
        responseFormat: "b64_json",
      }),
      dependencies
    );
    expect(response).toMatchObject({
      data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }],
    });
    expect(dependencies.loadStorageObject).toHaveBeenCalledWith(
      "user-1/generation-1.png",
      "generations"
    );
  });

  it("完成态 generation 跨用户时失败关闭", async () => {
    const dependencies = createDependencies({ userId: "user-other" });
    await expect(
      buildImageAsyncTaskPublicResponse(
        createTask({ status: "completed", completedAt: NOW }),
        dependencies
      )
    ).rejects.toThrowError(/generation 产物不一致/);
  });
});
