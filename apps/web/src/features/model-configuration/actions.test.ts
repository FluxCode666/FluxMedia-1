/**
 * 模型配置读取 Server Action 薄适配测试。
 *
 * 使用方是管理端模型配置页面；测试证明 Action 通过 Go 后端读取快照，不承载数据库或价格逻辑。
 */
import type { ModelConfigurationSnapshot } from "@repo/shared/model-marketplace";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestGoJson: vi.fn(),
}));

vi.mock("@repo/shared/safe-action", () => {
  type AdminActionHandler = (input: {
    parsedInput?: unknown;
    ctx: { userId: string; role: "admin" | "observer_admin" | "super_admin" };
  }) => Promise<unknown>;
  const builder = {
    metadata: () => builder,
    schema: () => builder,
    action: (handler: AdminActionHandler) => handler,
  };
  return { imageBackendPoolViewerAction: builder };
});

vi.mock("@/server/go-backend-client", () => ({
  requestGoJson: mocks.requestGoJson,
}));

import { getModelConfigurationAction } from "./actions";

const SNAPSHOT: ModelConfigurationSnapshot = {
  canEdit: true,
  runtimeCatalogStatus: "ready",
  entries: [],
};

/**
 * 调用被测试环境替换为普通函数的 Server Action。
 *
 * @param action - next-safe-action 导出在 Vitest mock 下的未知运行时值。
 * @param input - 模拟 viewer Action 中间件交付的真实会话上下文。
 * @returns Action handler 的异步输出。
 * @sideEffects 执行被测 Action；具体 UOL 调用由 spy 记录且不触达真实服务。
 * @failure 导出不是函数时显式抛错；被测 Action 的拒绝原因保持原样。
 */
function invokeMockAdminAction(
  action: unknown,
  input: {
    ctx: { userId: string; role: "admin" | "observer_admin" | "super_admin" };
  }
): Promise<unknown> {
  if (typeof action !== "function") {
    throw new Error("模型配置读取 Action 未导出为函数");
  }
  return Promise.resolve(Reflect.apply(action, undefined, [input]));
}

describe("getModelConfigurationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestGoJson.mockResolvedValue(SNAPSHOT);
  });

  it("通过 Go 快照接口读取并原样返回结果", async () => {
    await expect(
      invokeMockAdminAction(getModelConfigurationAction, {
        ctx: { userId: "admin-session-user", role: "observer_admin" },
      })
    ).resolves.toBe(SNAPSHOT);
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/admin/model-configuration");
  });

  it("Go 快照接口失败时保持原始异常", async () => {
    const failure = new Error("model configuration unavailable");
    mocks.requestGoJson.mockRejectedValue(failure);
    await expect(
      invokeMockAdminAction(getModelConfigurationAction, {
        ctx: { userId: "super-admin-session", role: "super_admin" },
      })
    ).rejects.toBe(failure);
  });

});
