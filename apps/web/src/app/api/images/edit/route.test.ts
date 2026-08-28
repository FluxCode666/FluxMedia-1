/**
 * 页面图生图路由的安全边界测试。
 *
 * 图生图包含上传与积分消耗；本测试确保携带有效 Cookie 会话的跨站请求仍会在解析
 * multipart 数据和上传临时图片前被 Origin 防护拦截。
 */

import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUserRoleById: vi.fn(),
  getMediaLimitDefaults: vi.fn(),
  invokeImageEnqueueAsyncOperation: vi.fn(),
  filesToMediaInputReferences: vi.fn(),
  stageImageInputReferences: vi.fn(),
  cleanupStagedImageInputs: vi.fn(),
}));

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: <T>(handler: T): T => handler,
}));
vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getUserRoleById,
}));
vi.mock("@repo/shared/image-generation/media-limit-service", () => ({
  getMediaLimitDefaults: mocks.getMediaLimitDefaults,
}));
vi.mock("@/features/image-generation/uol-client", () => ({
  invokeImageEnqueueAsyncOperation: mocks.invokeImageEnqueueAsyncOperation,
}));
vi.mock("@/features/image-generation/request-utils", () => ({
  filesToMediaInputReferences: mocks.filesToMediaInputReferences,
  formatMegabytes: vi.fn(),
  getTotalUploadSize: vi.fn(),
  uploadTemporaryImageUrls: vi.fn(),
  validateImageFile: vi.fn(),
  validateMaskMatchesSourceImage: vi.fn(),
}));
vi.mock("@/features/image-generation/image-input-storage", () => ({
  stageImageInputReferences: mocks.stageImageInputReferences,
  cleanupStagedImageInputs: mocks.cleanupStagedImageInputs,
}));

import { POST } from "./route";

/** 构造跨站图生图请求；路由必须在解析 multipart 前拒绝。 */
function createRequest(origin: string): NextRequest {
  return new Request("https://app.example.test/api/images/edit", {
    method: "POST",
    headers: { origin },
  }) as NextRequest;
}

/** 构造同源 multipart 图生图请求；model 由调用方决定是否写入。 */
function createFormRequest(formData: FormData): NextRequest {
  return new Request("https://app.example.test/api/images/edit", {
    method: "POST",
    headers: { origin: "https://app.example.test" },
    body: formData,
  }) as NextRequest;
}

describe("POST /api/images/edit", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.getUserRoleById.mockReset();
    mocks.getMediaLimitDefaults.mockReset();
    mocks.invokeImageEnqueueAsyncOperation.mockReset();
    mocks.filesToMediaInputReferences.mockReset();
    mocks.stageImageInputReferences.mockReset();
    mocks.cleanupStagedImageInputs.mockReset();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserRoleById.mockResolvedValue("user");
    mocks.getMediaLimitDefaults.mockResolvedValue({
      defaultUserConcurrency: 20,
      maxFileSizeMb: 10,
      maxUploadSizeMb: 20,
      maxEditReferenceImages: 16,
      maxFileSizeBytes: 10 * 1024 * 1024,
      maxUploadSizeBytes: 20 * 1024 * 1024,
    });
    vi.stubEnv("BETTER_AUTH_URL", "https://app.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("已登录的跨站请求在读取媒体限制、解析上传或发起生成前返回 403", async () => {
    const response = await POST(createRequest("https://attacker.example.test"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(mocks.getMediaLimitDefaults).not.toHaveBeenCalled();
    expect(mocks.invokeImageEnqueueAsyncOperation).not.toHaveBeenCalled();
  });

  it("同源请求缺少 model 时返回 400", async () => {
    const formData = new FormData();
    formData.set("prompt", "test prompt");

    const response = await POST(createFormRequest(formData));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "model is required" });
    expect(mocks.invokeImageEnqueueAsyncOperation).not.toHaveBeenCalled();
  });

  it.each([
    "count",
    "generationIds",
    "generation_ids",
  ])("显式批量字段 %s 即使表达单项也返回 400", async (field) => {
    const formData = new FormData();
    formData.set("prompt", "test prompt");
    formData.set(field, field === "count" ? "1" : "generation-1");

    const response = await POST(createFormRequest(formData));

    expect(response.status).toBe(400);
    expect(mocks.invokeImageEnqueueAsyncOperation).not.toHaveBeenCalled();
  });

  it("将上传图片转成持久引用后返回已入队任务", async () => {
    const sourceFile = new File(["png"], "source.png", {
      type: "image/png",
    });
    const sourceReference = {
      source: "data" as const,
      mimeType: "image/png" as const,
      base64: "cG5n",
      byteLength: 3,
    };
    const storedReference = {
      source: "storage" as const,
      mimeType: "image/png" as const,
      storageKey: "user-1/image-inputs/source.png",
      storageBucket: "generations",
      byteLength: 3,
    };
    mocks.filesToMediaInputReferences.mockResolvedValueOnce([sourceReference]);
    mocks.stageImageInputReferences.mockResolvedValueOnce({
      references: [storedReference],
      objects: [],
    });
    mocks.invokeImageEnqueueAsyncOperation.mockResolvedValueOnce({
      taskId: "task_edit",
      model: "gpt-image-2",
      operation: "edit",
      status: "queued",
      generationId: "generation-edit",
      responseFormat: "url",
      createdAt: "2026-08-28T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      error: null,
    });

    const formData = new FormData();
    formData.set("prompt", "edit prompt");
    formData.set("model", "gpt-image-2");
    formData.append("image[]", sourceFile);
    const response = await POST(createFormRequest(formData));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      taskId: "task_edit",
      status: "queued",
      generationId: "generation-edit",
    });
    expect(mocks.stageImageInputReferences).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        references: [sourceReference],
      })
    );
    expect(mocks.invokeImageEnqueueAsyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        generationInput: expect.objectContaining({
          operation: "edit",
          images: [storedReference],
        }),
      }),
      { type: "user", userId: "user-1", role: "user" },
      undefined
    );
  });
});
