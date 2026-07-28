/**
 * 站内视频创建路由契约测试。
 *
 * 职责：验证路由只调用一次 video.generate 并立即返回 202/taskId，不在请求进程内
 * 轮询 video.getStatus。
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: <T>(handler: T) => handler,
}));
vi.mock("@repo/shared/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: vi.fn(),
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: vi.fn(),
}));
vi.mock("@/features/image-generation/request-security", () => ({
  hasTrustedImageGenerationOrigin: vi.fn(() => true),
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: vi.fn(),
}));

import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { invokeOperation } from "@repo/shared/uol";
import { POST } from "./route";

const getSessionMock = vi.mocked(auth.api.getSession);
const getUserRoleByIdMock = vi.mocked(getUserRoleById);
const invokeOperationMock = vi.mocked(invokeOperation);

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue({
    user: { id: "user-1" },
  } as Awaited<ReturnType<typeof auth.api.getSession>>);
  getUserRoleByIdMock.mockResolvedValue("user");
  invokeOperationMock.mockResolvedValue({
    taskId: "video-1",
    status: "processing",
  });
});

describe("POST /api/videos/generate", () => {
  it("创建后立即返回 accepted，而不在服务端轮询状态", async () => {
    const response = await POST(
      new NextRequest("https://app.example.com/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "request-1",
          prompt: "海边日落",
          model: "firefly-sora2-4s-16x9",
        }),
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      taskId: "video-1",
      status: "processing",
    });
    expect(invokeOperationMock).toHaveBeenCalledTimes(1);
    expect(invokeOperationMock).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({ clientRequestId: "request-1" }),
      expect.objectContaining({ type: "user", userId: "user-1" }),
      expect.any(Object)
    );
  });

  it("将显式关闭声音的 false 原样传给 UOL", async () => {
    const response = await POST(
      new NextRequest("https://app.example.com/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "request-audio-off",
          prompt: "海边日落",
          model: "firefly-seedance2-15s-9x16-480p",
          generateAudio: false,
        }),
      })
    );

    expect(response.status).toBe(202);
    expect(invokeOperationMock).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({
        clientRequestId: "request-audio-off",
        generateAudio: false,
      }),
      expect.objectContaining({ type: "user", userId: "user-1" }),
      expect.any(Object)
    );
  });
});
