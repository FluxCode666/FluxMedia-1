/**
 * 模型广场页面数据边界测试。
 *
 * 使用方是 Vitest；验证成功空目录、严格 DTO、依赖异常和畸形输出不会被混为同一状态。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  getServerSession: vi.fn(),
  getUserRoleById: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: runtimeMocks.getUserRoleById,
}));
vi.mock("@repo/shared/auth/server", () => ({
  getServerSession: runtimeMocks.getServerSession,
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: runtimeMocks.invokeOperation,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: runtimeMocks.ensureUolInitialized,
}));

import { loadModelMarketplacePageData } from "./page-data";

const PUBLIC_IMAGE = {
  category: "image" as const,
  configKey: "gpt-image-2",
  modelId: "gpt-image-2",
  displayName: "GPT Image 2",
  iconKey: "openai" as const,
  description: "Image generation",
  coverUrl: "/model-marketplace/default-image.webp",
  minimumCredits: 1.27,
  homepageVisible: true,
  homepagePriority: 5,
  priceUnit: "per_image" as const,
  pricing: {
    base1024Credits: 1.27,
    base1kCredits: 1.5,
    base2kCredits: 2.5,
    base4kCredits: 5,
  },
};

describe("loadModelMarketplacePageData", () => {
  beforeEach(() => {
    for (const mock of Object.values(runtimeMocks)) mock.mockReset();
    runtimeMocks.ensureUolInitialized.mockResolvedValue(undefined);
    runtimeMocks.getServerSession.mockResolvedValue(null);
    runtimeMocks.getUserRoleById.mockResolvedValue("user");
  });

  it("匿名生产路径以 system Principal 调用公开目录 operation", async () => {
    runtimeMocks.invokeOperation.mockResolvedValueOnce({
      items: [PUBLIC_IMAGE],
    });

    await expect(loadModelMarketplacePageData()).resolves.toEqual({
      status: "ready",
      models: [PUBLIC_IMAGE],
    });
    expect(runtimeMocks.getServerSession).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.getUserRoleById).not.toHaveBeenCalled();
    expect(runtimeMocks.ensureUolInitialized).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.invokeOperation).toHaveBeenCalledWith(
      "modelMarketplace.listPublicModels",
      {},
      { type: "system", reason: "public-model-marketplace-page" },
      { requestId: expect.any(String) }
    );
  });

  it("登录生产路径读取真实角色并以 user Principal 调用公开目录", async () => {
    runtimeMocks.getServerSession.mockResolvedValueOnce({
      user: { id: "user-1" },
    });
    runtimeMocks.getUserRoleById.mockResolvedValueOnce("admin");
    runtimeMocks.invokeOperation.mockResolvedValueOnce({ items: [] });

    await expect(loadModelMarketplacePageData()).resolves.toEqual({
      status: "ready",
      models: [],
    });
    expect(runtimeMocks.getUserRoleById).toHaveBeenCalledWith("user-1");
    expect(runtimeMocks.invokeOperation).toHaveBeenCalledWith(
      "modelMarketplace.listPublicModels",
      {},
      { type: "user", userId: "user-1", role: "admin" },
      { requestId: expect.any(String) }
    );
  });

  it("返回严格公开模型且不添加页面私有字段", async () => {
    await expect(
      loadModelMarketplacePageData(async () => ({ items: [PUBLIC_IMAGE] }))
    ).resolves.toEqual({ status: "ready", models: [PUBLIC_IMAGE] });
  });

  it("成功空目录保持 ready，供页面显示已发布为空", async () => {
    await expect(
      loadModelMarketplacePageData(async () => ({ items: [] }))
    ).resolves.toEqual({ status: "ready", models: [] });
  });

  it("依赖异常或严格输出失败统一降级 unavailable", async () => {
    await expect(
      loadModelMarketplacePageData(async () => {
        throw new Error("database unavailable");
      })
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      loadModelMarketplacePageData(async () => ({
        items: [{ ...PUBLIC_IMAGE, bucket: "private-assets" }],
      }))
    ).resolves.toEqual({ status: "unavailable" });
  });
});
