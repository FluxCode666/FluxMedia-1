/**
 * 模型配置读取 Server Action 薄适配测试。
 *
 * 使用方是管理端模型配置页面；测试证明 Action 先初始化 UOL，只从真实管理员会话上下文
 * 构造 user Principal，并原样返回 settings.getModelConfiguration 输出，不承载数据库或价格逻辑。
 */
import type { ModelConfigurationSnapshot } from "@repo/shared/model-marketplace";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("@repo/shared/safe-action", () => {
  type AdminActionHandler = (input: {
    ctx: { userId: string; role: "admin" | "observer_admin" | "super_admin" };
  }) => Promise<unknown>;
  const builder = {
    metadata: () => builder,
    action: (handler: AdminActionHandler) => handler,
  };
  return { imageBackendPoolViewerAction: builder };
});

vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));

vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
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
 * @param input - 模拟 adminAction 中间件交付的真实会话上下文。
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
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue(SNAPSHOT);
  });

  it("先初始化 UOL，再以真实管理员会话 Principal 调用唯一读取 operation", async () => {
    const sequence: string[] = [];
    mocks.ensureUolInitialized.mockImplementation(async () => {
      sequence.push("initialize");
    });
    mocks.invokeOperation.mockImplementation(async () => {
      sequence.push("invoke");
      return SNAPSHOT;
    });

    await expect(
      invokeMockAdminAction(getModelConfigurationAction, {
        ctx: { userId: "admin-session-user", role: "observer_admin" },
      })
    ).resolves.toBe(SNAPSHOT);

    expect(sequence).toEqual(["initialize", "invoke"]);
    expect(mocks.ensureUolInitialized).toHaveBeenCalledOnce();
    expect(mocks.invokeOperation).toHaveBeenCalledOnce();
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "settings.getModelConfiguration",
      {},
      {
        type: "user",
        userId: "admin-session-user",
        role: "observer_admin",
      }
    );
  });

  it("UOL 初始化失败时不调用 operation 且保持原始异常", async () => {
    const failure = new Error("UOL initialization failed");
    mocks.ensureUolInitialized.mockRejectedValue(failure);

    await expect(
      invokeMockAdminAction(getModelConfigurationAction, {
        ctx: { userId: "admin-session-user", role: "admin" },
      })
    ).rejects.toBe(failure);
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("读取 operation 失败时不伪造空快照或合并价格", async () => {
    const failure = new Error("model configuration unavailable");
    mocks.invokeOperation.mockRejectedValue(failure);

    await expect(
      invokeMockAdminAction(getModelConfigurationAction, {
        ctx: { userId: "super-admin-session", role: "super_admin" },
      })
    ).rejects.toBe(failure);
    expect(mocks.invokeOperation).toHaveBeenCalledOnce();
  });
});
