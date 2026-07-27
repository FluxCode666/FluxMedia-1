/** 管理员视频提交核对路由测试；所有鉴权和 UOL 调用均使用桩。 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  getSession: vi.fn(),
  getUserRoleById: vi.fn(),
  hasTrustedOrigin: vi.fn(),
  invokeOperation: vi.fn(),
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
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: class OperationError extends Error {},
}));
vi.mock("@/features/image-generation/request-security", () => ({
  hasTrustedImageGenerationOrigin: mocks.hasTrustedOrigin,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { GET, POST } from "./route";

describe("admin video reconciliation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "admin-1" } });
    mocks.getUserRoleById.mockResolvedValue("admin");
    mocks.hasTrustedOrigin.mockReturnValue(true);
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
  });

  it("GET 经 UOL 返回待核对任务", async () => {
    mocks.invokeOperation.mockResolvedValue({ items: [] });
    const request = new NextRequest(
      "https://app.example.com/api/admin/videos/reconciliation?limit=20"
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.listUncertainSubmissions",
      { limit: 20 },
      expect.objectContaining({
        type: "user",
        userId: "admin-1",
        role: "admin",
      }),
      expect.any(Object)
    );
  });

  it("POST 拒绝跨站 Cookie 写请求", async () => {
    mocks.hasTrustedOrigin.mockReturnValue(false);
    const request = new NextRequest(
      "https://app.example.com/api/admin/videos/reconciliation",
      {
        method: "POST",
        body: JSON.stringify({
          outcome: "not_accepted",
          taskId: "video-1",
          reason: "not found upstream",
        }),
      }
    );

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("POST 只把核对结论提交给 UOL", async () => {
    const body = {
      outcome: "not_accepted",
      taskId: "video-1",
      reason: "not found upstream",
    };
    mocks.invokeOperation.mockResolvedValue({
      taskId: "video-1",
      status: "failed",
    });
    const request = new NextRequest(
      "https://app.example.com/api/admin/videos/reconciliation",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.reconcileSubmission",
      body,
      expect.objectContaining({ role: "admin" }),
      expect.any(Object)
    );
  });
});
