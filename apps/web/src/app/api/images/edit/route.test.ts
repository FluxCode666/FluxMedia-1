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
  getPlanUploadLimits: vi.fn(),
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
vi.mock("@repo/shared/subscription/services/upload-limits", () => ({
  getPlanUploadLimits: mocks.getPlanUploadLimits,
}));
vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: mocks.getUserPlan,
}));
vi.mock("@/features/image-generation/uol-client", () => ({
  invokeImageGenerationOperation: mocks.invokeImageGenerationOperation,
}));
vi.mock("@/features/image-generation/request-utils", () => ({
  deleteTemporaryImages: vi.fn(),
  filesToMediaInputReferences: vi.fn(),
  formatMegabytes: vi.fn(),
  getTotalUploadSize: vi.fn(),
  uploadTemporaryImageUrls: vi.fn(),
  validateImageFile: vi.fn(),
  validateMaskMatchesSourceImage: vi.fn(),
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
    mocks.getPlanUploadLimits.mockReset();
    mocks.getUserPlan.mockReset();
    mocks.invokeImageGenerationOperation.mockReset();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserPlan.mockResolvedValue({ plan: "free" });
    mocks.getUserRoleById.mockResolvedValue("user");
    mocks.getPlanUploadLimits.mockResolvedValue({
      maxFileSizeBytes: 10 * 1024 * 1024,
      maxUploadBytes: 20 * 1024 * 1024,
      maxEditImages: 16,
    });
    vi.stubEnv("BETTER_AUTH_URL", "https://app.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("已登录的跨站请求在读取套餐、解析上传或发起生成前返回 403", async () => {
    const response = await POST(createRequest("https://attacker.example.test"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(mocks.getPlanUploadLimits).not.toHaveBeenCalled();
    expect(mocks.getUserPlan).not.toHaveBeenCalled();
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
  });

  it("同源请求缺少 model 时返回 400", async () => {
    const formData = new FormData();
    formData.set("prompt", "test prompt");

    const response = await POST(createFormRequest(formData));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "model is required" });
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
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
    expect(mocks.invokeImageGenerationOperation).not.toHaveBeenCalled();
  });
});
