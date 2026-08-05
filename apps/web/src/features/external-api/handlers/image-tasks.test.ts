/**
 * 外部图片任务查询传输测试。
 *
 * 职责：验证 task_ ID 先经 UOL 查询 PostgreSQL 持久任务，未命中时仅为同步
 * generation_id 保留归属校验回退，不再读取进程内 Map。
 */
import { OperationError } from "@repo/shared/uol";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateExternalApiRequest: vi.fn(),
  getGenerationById: vi.fn(),
  invokeImageGetAsyncTaskOperation: vi.fn(),
}));

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: <T>(handler: T) => handler,
}));

vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: mocks.authenticateExternalApiRequest,
}));

vi.mock("@/features/external-api/images", () => ({
  openAIImageError: (message: string, status = 400) =>
    Response.json({ error: { message } }, { status }),
}));

vi.mock("@/features/image-generation/queries", () => ({
  getGenerationById: mocks.getGenerationById,
}));

vi.mock("@/features/image-generation/uol-client", () => ({
  invokeImageGetAsyncTaskOperation: mocks.invokeImageGetAsyncTaskOperation,
}));

import { getExternalImageTask } from "./image-tasks";

/** 构造固定 API Key 与请求标识的任务查询请求。 */
function createRequest(
  taskId: string
): [NextRequest, { params: Promise<{ taskId: string }> }] {
  return [
    new NextRequest(`https://app.example.test/v1/images/${taskId}`, {
      headers: {
        authorization: "Bearer external-key",
        "x-request-id": "request-task-1",
      },
    }),
    { params: Promise.resolve({ taskId }) },
  ];
}

describe("external image task query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BETTER_AUTH_SECRET = "test-storage-signing-secret";
    mocks.authenticateExternalApiRequest.mockResolvedValue({
      userId: "user-1",
      apiKeyId: "key-1",
    });
    mocks.invokeImageGetAsyncTaskOperation.mockResolvedValue({
      taskId: "task_123",
      model: "gpt-image-2",
      operation: "generate",
      status: "queued",
      generationId: "generation-1",
      responseFormat: "url",
      createdAt: "2026-08-04T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      error: null,
    });
  });

  it("通过 UOL 查询持久任务并映射兼容 processing 响应", async () => {
    const response = await getExternalImageTask(...createRequest("task_123"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      id: "task_123",
      object: "image.generation",
      status: "processing",
      generation_id: "generation-1",
    });
    expect(mocks.invokeImageGetAsyncTaskOperation).toHaveBeenCalledWith(
      { taskId: "task_123" },
      {
        type: "apiKey",
        credentialKind: "external",
        userId: "user-1",
        apiKeyId: "key-1",
      },
      "request-task-1"
    );
    expect(mocks.getGenerationById).not.toHaveBeenCalled();
  });

  it("UOL 未命中时为同步 generation_id 保留数据库回退", async () => {
    mocks.invokeImageGetAsyncTaskOperation.mockRejectedValue(
      new OperationError("not_found", "Image async task not found")
    );
    mocks.getGenerationById.mockResolvedValue({
      id: "generation-1",
      userId: "user-1",
      model: "gpt-image-2",
      status: "completed",
      revisedPrompt: null,
      storageKey: "user-1/generation-1.png",
      storageBucket: "generations",
      creditsConsumed: "1.5",
      error: null,
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
      completedAt: new Date("2026-08-04T00:00:01.000Z"),
    });

    const response = await getExternalImageTask(
      ...createRequest("generation-1")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "generation-1",
      status: "completed",
      generation_id: "generation-1",
    });
  });

  it("UOL 内部错误不会降级为无归属的 generation 查询", async () => {
    mocks.invokeImageGetAsyncTaskOperation.mockRejectedValue(
      new OperationError("internal_error", "Database unavailable")
    );

    const response = await getExternalImageTask(...createRequest("task_123"));

    expect(response.status).toBe(500);
    expect(mocks.getGenerationById).not.toHaveBeenCalled();
  });
});
