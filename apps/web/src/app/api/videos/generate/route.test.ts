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
    status: "in_progress",
  });
});

describe("POST /api/videos/generate", () => {
  it("把真实模型、独立参数和具名首尾帧传给 UOL", async () => {
    const firstFrame = `data:image/png;base64,${Buffer.from("first").toString(
      "base64"
    )}`;
    const lastFrame = `data:image/png;base64,${Buffer.from("last").toString(
      "base64"
    )}`;
    const response = await POST(
      new NextRequest("https://app.example.com/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "request-1",
          prompt: "海边日落",
          model: "seedance2",
          duration: 10,
          aspectRatio: "16:9",
          resolution: "1080p",
          firstFrame,
          lastFrame,
        }),
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      taskId: "video-1",
      status: "in_progress",
      model: "seedance2",
      duration: 10,
      aspectRatio: "16:9",
      resolution: "1080p",
    });
    expect(invokeOperationMock).toHaveBeenCalledTimes(1);
    expect(invokeOperationMock).toHaveBeenCalledWith(
      "video.generate",
      {
        clientRequestId: "request-1",
        prompt: "海边日落",
        model: "seedance2",
        duration: 10,
        aspectRatio: "16:9",
        resolution: "1080p",
        firstFrame: expect.objectContaining({
          source: "data",
          byteLength: 5,
        }),
        lastFrame: expect.objectContaining({
          source: "data",
          byteLength: 4,
        }),
      },
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
          model: "seedance2",
          duration: 15,
          aspectRatio: "9:16",
          resolution: "480p",
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

  it("已持久化但无合格账号时以 202 返回 failed 和安全原因", async () => {
    invokeOperationMock.mockResolvedValueOnce({
      taskId: "video-no-account",
      status: "failed",
      error: "当前没有可用生成服务",
    });
    const response = await POST(
      new NextRequest("https://app.example.com/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "request-no-account",
          prompt: "海边日落",
          model: "seedance2",
          duration: 15,
          aspectRatio: "9:16",
          resolution: "480p",
        }),
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      taskId: "video-no-account",
      status: "failed",
      error: "当前没有可用生成服务",
    });
  });

  it("把参考图数组转换为有序具名媒体引用", async () => {
    const image = `data:image/png;base64,${Buffer.from("image").toString(
      "base64"
    )}`;
    const response = await POST(
      new NextRequest("https://app.example.com/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "request-reference",
          prompt: "角色在城市中行走",
          model: "kling3-omni",
          duration: 8,
          aspectRatio: "16:9",
          resolution: "1080p",
          referenceImages: [image],
        }),
      })
    );

    expect(response.status).toBe(202);
    expect(invokeOperationMock).toHaveBeenCalledWith(
      "video.generate",
      expect.objectContaining({
        referenceImages: [
          expect.objectContaining({ source: "data", byteLength: 5 }),
        ],
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it.each([
    ["duration", { aspectRatio: "16:9", resolution: "720p" }],
    ["aspectRatio", { duration: 4, resolution: "720p" }],
    ["resolution", { duration: 4, aspectRatio: "16:9" }],
  ])("缺少必填字段 %s 时拒绝请求", async (_field, parameters) => {
    const response = await POST(
      new NextRequest("https://app.example.com/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "request-missing",
          prompt: "海边日落",
          model: "sora2",
          ...parameters,
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(invokeOperationMock).not.toHaveBeenCalled();
  });

  it.each([
    ["复合模型 ID", { model: "sora2-4s-16x9-720p" }],
    ["旧前缀模型 ID", { model: "firefly-sora2-4s-16x9" }],
    ["snake_case", { aspect_ratio: "16:9" }],
    ["旧输入数组", { inputImages: [] }],
    ["旧输入角色", { inputImageRole: "frame" }],
  ])("拒绝%s", async (_caseName, invalidFields) => {
    const response = await POST(
      new NextRequest("https://app.example.com/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "request-invalid",
          prompt: "海边日落",
          model: "sora2",
          duration: 4,
          aspectRatio: "16:9",
          resolution: "720p",
          ...invalidFields,
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(invokeOperationMock).not.toHaveBeenCalled();
  });
});
