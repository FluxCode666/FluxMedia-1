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
  canUsePlanCapability: vi.fn(),
  getPlanLimits: vi.fn(),
  getUserRoleById: vi.fn(),
  getUserPlan: vi.fn(),
  invokeImageGenerationOperation: vi.fn(),
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
vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: mocks.canUsePlanCapability,
  getPlanLimits: mocks.getPlanLimits,
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: mocks.getUserPlan,
}));
vi.mock("@/features/image-generation/batch-runner", () => ({
  firstBatchError: vi.fn(),
  runBatchImageGeneration: vi.fn(),
}));
vi.mock("@/features/image-generation/uol-client", () => ({
  invokeImageGenerationOperation: mocks.invokeImageGenerationOperation,
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
    mocks.canUsePlanCapability.mockReset();
    mocks.getPlanLimits.mockReset();
    mocks.getUserPlan.mockReset();
    mocks.getUserRoleById.mockReset();
    mocks.invokeImageGenerationOperation.mockReset();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.canUsePlanCapability.mockResolvedValue(true);
    mocks.getPlanLimits.mockResolvedValue({
      imageGenerationConcurrency: 20,
      maxBatchCount: 1,
    });
    mocks.getUserPlan.mockResolvedValue({ plan: "free" });
    mocks.getUserRoleById.mockResolvedValue("user");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("已登录的跨站请求在读取套餐或发起生成前返回 403", async () => {
    const response = await POST(createRequest("https://attacker.example.test"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(mocks.getUserPlan).not.toHaveBeenCalled();
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
  });

  it("同源请求缺少 model 时返回 400", async () => {
    const response = await POST(createRequest("https://app.example.test"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "model is required" });
    expect(mocks.getUserPlan).not.toHaveBeenCalled();
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
  });

  it("用户并发超限时返回 429 和稳定 code/details", async () => {
    mocks.invokeImageGenerationOperation.mockRejectedValueOnce(
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
});
