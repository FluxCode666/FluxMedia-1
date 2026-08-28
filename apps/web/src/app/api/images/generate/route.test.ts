/**
 * 页面文生图路由的安全边界测试。
 *
 * 覆盖 Cookie 会话已存在时的跨站请求拒绝，确保 Better Auth 全局兼容配置不会让
 * 算力消耗接口失去 CSRF 防护。
 */

import { OperationError } from "@repo/shared/uol";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUserRoleById: vi.fn(),
  invokeImageEnqueueAsyncOperation: vi.fn(),
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
vi.mock("@/features/image-generation/uol-client", () => ({
  invokeImageEnqueueAsyncOperation: mocks.invokeImageEnqueueAsyncOperation,
}));

import { POST } from "./route";

/** 构造页面生图 JSON 请求；可覆盖请求体以验证参数边界。 */
function createRequest(
  origin: string,
  body: Record<string, unknown> = { prompt: "test prompt" }
): NextRequest {
  return new Request("https://app.example.test/api/images/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe("POST /api/images/generate", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.getUserRoleById.mockReset();
    mocks.invokeImageEnqueueAsyncOperation.mockReset();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserRoleById.mockResolvedValue("user");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("已登录的跨站请求在读取角色或发起生成前返回 403", async () => {
    const response = await POST(createRequest("https://attacker.example.test"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(mocks.getUserRoleById).not.toHaveBeenCalled();
    expect(mocks.invokeImageEnqueueAsyncOperation).not.toHaveBeenCalled();
  });

  it("同源请求缺少 model 时返回 400", async () => {
    const response = await POST(createRequest("https://app.example.test"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "model is required" });
    expect(mocks.getUserRoleById).not.toHaveBeenCalled();
    expect(mocks.invokeImageEnqueueAsyncOperation).not.toHaveBeenCalled();
  });

  it.each([
    "count",
    "generationIds",
    "generation_ids",
  ])("显式批量字段 %s 即使表达单项也返回 400", async (field) => {
    const response = await POST(
      createRequest("https://app.example.test", {
        prompt: "test prompt",
        model: "gpt-image-2",
        [field]: field === "count" ? 1 : ["generation-1"],
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.invokeImageEnqueueAsyncOperation).not.toHaveBeenCalled();
  });

  it("用户并发超限时返回 429 和稳定 code/details", async () => {
    mocks.invokeImageEnqueueAsyncOperation.mockRejectedValueOnce(
      new OperationError(
        "concurrency_limit_exceeded",
        "用户同时进行的生图任务已达到上限 20",
        {
          limit: 20,
          effectiveSource: "system_default",
          scope: "user",
        }
      )
    );

    const response = await POST(
      createRequest("https://app.example.test", {
        prompt: "test prompt",
        model: "gpt-image-2",
      })
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "用户同时进行的生图任务已达到上限 20",
      code: "concurrency_limit_exceeded",
      details: {
        limit: 20,
        effectiveSource: "system_default",
        scope: "user",
      },
    });
  });

  it("先返回已入队任务，不等待上游图片完成", async () => {
    mocks.invokeImageEnqueueAsyncOperation.mockResolvedValueOnce({
      taskId: "task_queued",
      model: "gpt-image-2",
      operation: "generate",
      status: "queued",
      generationId: "generation-queued",
      responseFormat: "url",
      createdAt: "2026-08-28T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      error: null,
    });

    const response = await POST(
      createRequest("https://app.example.test", {
        prompt: "test prompt",
        model: "gpt-image-2",
        generationId: "generation-queued",
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      taskId: "task_queued",
      status: "queued",
      generationId: "generation-queued",
    });
    expect(mocks.invokeImageEnqueueAsyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: expect.stringMatching(/^task_/),
        responseFormat: "url",
        generationInput: expect.objectContaining({
          operation: "generate",
          generationId: "generation-queued",
        }),
      }),
      { type: "user", userId: "user-1", role: "user" },
      undefined
    );
  });
});
