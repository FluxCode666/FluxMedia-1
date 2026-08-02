/**
 * 视频输入资产授权与账号删除生命周期测试。
 *
 * 职责：覆盖 owner、历史管理员、普通用户与 API Key 边界，证明签名只来自任务白名单
 * 且站内详情不会泄露 bucket、key 或供应商素材 ID。
 */
import type { OperationContext, Principal } from "@repo/shared/uol";
import { describe, expect, it, vi } from "vitest";

import {
  getVideoInputAssets,
  requestVideoAccountInputCleanup,
  type VideoInputAssetDependencies,
  type VideoInputAssetTask,
} from "./video-input-assets";

const TASK: VideoInputAssetTask = {
  id: "video-1",
  userId: "owner-1",
  inputManifest: {
    firstFrame: {
      source: "storage",
      mimeType: "image/png",
      storageKey:
        "owner-1/video-inputs/video-1/reservation-1/first-frame-0-a.png",
      storageBucket: "uploads",
      byteLength: 12,
    },
    lastFrame: {
      source: "storage",
      mimeType: "image/jpeg",
      storageKey:
        "owner-1/video-inputs/video-1/reservation-1/last-frame-0-b.jpg",
      storageBucket: "uploads",
      byteLength: 13,
    },
  },
};

/** 构造不连接数据库和存储的服务依赖。 */
function createDependencies(
  task: VideoInputAssetTask = TASK
): VideoInputAssetDependencies {
  return {
    findTask: vi.fn(async (taskId) => (taskId === task.id ? task : null)),
    listUserTasks: vi.fn(async (userId) =>
      userId === task.userId ? [task] : []
    ),
    getCurrentBucket: vi.fn(async () => "uploads"),
    signAsset: vi.fn(
      async ({ storageKey }) =>
        `https://app.example.com/signed/${encodeURIComponent(storageKey)}`
    ),
    enqueueLifecycleCleanup: vi.fn(async (objects) => objects.length),
  };
}

/** 构造可观察 owner 断言的统一操作上下文。 */
function createContext(): OperationContext {
  return {
    requestId: "request-1",
    assertOwnership: vi.fn(),
  };
}

describe("video input assets", () => {
  it("owner 获取具名短期 URL 且输出不泄露存储身份", async () => {
    const context = createContext();
    const output = await getVideoInputAssets(
      {
        taskId: "video-1",
        principal: { type: "user", userId: "owner-1", role: "user" },
        context,
      },
      createDependencies()
    );

    expect(context.assertOwnership).toHaveBeenCalledWith(
      "video task inputs",
      "owner-1"
    );
    expect(output).toMatchObject({
      taskId: "video-1",
      summary: { mode: "first-last-frames", count: 2 },
      firstFrame: { mimeType: "image/png" },
      lastFrame: { mimeType: "image/jpeg" },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("storageBucket");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("providerAssetId");
  });

  it.each([
    "observer_admin",
    "admin",
    "super_admin",
  ] as const)("%s 沿用全局历史权限读取其他用户任务", async (role) => {
    const context = createContext();
    await expect(
      getVideoInputAssets(
        {
          taskId: "video-1",
          principal: { type: "user", userId: `${role}-1`, role },
          context,
        },
        createDependencies()
      )
    ).resolves.toMatchObject({ taskId: "video-1" });
    expect(context.assertOwnership).not.toHaveBeenCalled();
  });

  it.each<Principal>([
    { type: "user", userId: "other-1", role: "user" },
    {
      type: "apiKey",
      credentialKind: "external",
      userId: "owner-1",
      apiKeyId: "key-1",
      plan: "pro",
    },
    {
      type: "apiKey",
      credentialKind: "mcp",
      userId: "owner-1",
      apiKeyId: "mcp-1",
      plan: "pro",
    },
  ])("拒绝非 owner 普通用户与任何 API Key", async (principal) => {
    await expect(
      getVideoInputAssets(
        { taskId: "video-1", principal, context: createContext() },
        createDependencies()
      )
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it.each([
    {
      storageKey: "other-1/video-inputs/video-1/reservation-1/stolen.png",
      storageBucket: "uploads",
    },
    {
      storageKey:
        "owner-1/video-inputs/other-video/reservation-1/stolen.png",
      storageBucket: "uploads",
    },
    {
      storageKey:
        "owner-1/video-inputs/video-1/reservation-1/stolen.png",
      storageBucket: "other-bucket",
    },
  ])("清单 bucket、用户或任务前缀不可信时不签发 URL", async (asset) => {
    const dependencies = createDependencies({
      ...TASK,
      inputManifest: {
        firstFrame: {
          source: "storage",
          mimeType: "image/png",
          ...asset,
          byteLength: 12,
        },
      },
    });

    await expect(
      getVideoInputAssets(
        {
          taskId: "video-1",
          principal: { type: "user", userId: "owner-1", role: "user" },
          context: createContext(),
        },
        dependencies
      )
    ).rejects.toMatchObject({ code: "internal_error" });
    expect(dependencies.signAsset).not.toHaveBeenCalled();
  });

  it("账号删除只从清单登记 lifecycle_delete 且请求 ID 稳定", async () => {
    const dependencies = createDependencies();

    const first = await requestVideoAccountInputCleanup(
      { userId: "owner-1", clientRequestId: "delete-account-v1" },
      dependencies
    );
    const second = await requestVideoAccountInputCleanup(
      { userId: "owner-1", clientRequestId: "delete-account-v1" },
      dependencies
    );

    expect(second.cleanupRequestId).toBe(first.cleanupRequestId);
    expect(dependencies.enqueueLifecycleCleanup).toHaveBeenCalledWith([
      expect.objectContaining({
        reason: "lifecycle_delete",
        videoId: "video-1",
        attemptId: "reservation-1",
      }),
      expect.objectContaining({
        reason: "lifecycle_delete",
        videoId: "video-1",
        attemptId: "reservation-1",
      }),
    ]);
  });
});
