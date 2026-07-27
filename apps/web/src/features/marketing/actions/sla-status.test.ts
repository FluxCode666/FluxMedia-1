/**
 * 首页 SLA 展示开关 Server Action 传输核心测试。
 *
 * 使用方：Vitest；绕开 next-safe-action 会话中间件，直接验证真实用户 Principal、
 * 权限错误映射和未知异常的安全日志边界，不连接数据库。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  getUserRoleById: vi.fn(),
  invokeOperation: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: runtimeMocks.getUserRoleById,
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { error: runtimeMocks.loggerError },
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: runtimeMocks.invokeOperation,
}));
vi.mock("@repo/shared/safe-action", () => {
  class ActionUserError extends Error {
    /** 构造可断言的测试用户错误。 */
    constructor(message: string) {
      super(message);
      this.name = "ActionUserError";
    }
  }

  type TestActionBuilder = {
    metadata: (_metadata: unknown) => TestActionBuilder;
    schema: (_schema: unknown) => TestActionBuilder;
    action: <TAction>(_handler: TAction) => TAction;
  };
  const builder = {} as TestActionBuilder;
  builder.metadata = () => builder;
  builder.schema = () => builder;
  builder.action = <TAction>(handler: TAction) => handler;

  return { ActionUserError, protectedAction: builder };
});
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: runtimeMocks.ensureUolInitialized,
}));

import { OperationError } from "@repo/shared/uol/errors";
import { runMarketingSlaVisibilityUpdate } from "./sla-status";

describe("runMarketingSlaVisibilityUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.ensureUolInitialized.mockResolvedValue(undefined);
    runtimeMocks.getUserRoleById.mockResolvedValue("admin");
    runtimeMocks.invokeOperation.mockResolvedValue({ enabled: false });
  });

  it("使用受保护会话的 userId 与实时角色构造真实 user Principal", async () => {
    await expect(
      runMarketingSlaVisibilityUpdate({ enabled: false }, "admin-1")
    ).resolves.toEqual({ enabled: false });

    expect(runtimeMocks.ensureUolInitialized).toHaveBeenCalledOnce();
    expect(runtimeMocks.getUserRoleById).toHaveBeenCalledWith("admin-1");
    expect(runtimeMocks.invokeOperation).toHaveBeenCalledWith(
      "settings.setMarketingSlaVisibility",
      { enabled: false },
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expect(
      runtimeMocks.ensureUolInitialized.mock.invocationCallOrder[0] ?? 0
    ).toBeLessThan(
      runtimeMocks.invokeOperation.mock.invocationCallOrder[0] ?? 0
    );
  });

  it.each([
    "forbidden",
    "unauthenticated",
  ] as const)("把 UOL %s 稳定映射为管理员权限提示", async (code) => {
    runtimeMocks.invokeOperation.mockRejectedValue(
      new OperationError(code, `secret-${code}`)
    );

    await expect(
      runMarketingSlaVisibilityUpdate({ enabled: true }, "admin-1")
    ).rejects.toThrow("此操作需要管理员权限");
    expect(runtimeMocks.loggerError).toHaveBeenCalledWith(
      {
        event: "marketing_sla_visibility_update_failed",
        safeCode: code,
      },
      "Homepage SLA visibility update failed"
    );
    expect(JSON.stringify(runtimeMocks.loggerError.mock.calls)).not.toContain(
      `secret-${code}`
    );
  });

  it("未知异常返回通用提示且安全日志不包含原始异常", async () => {
    const canary = new Error(
      "https://user:password@example.test Bearer token-canary SELECT api_key=key-canary"
    );
    canary.stack = "stack-canary";
    runtimeMocks.invokeOperation.mockRejectedValue(canary);

    await expect(
      runMarketingSlaVisibilityUpdate({ enabled: true }, "admin-1")
    ).rejects.toThrow("更新首页 SLA 展示失败，请稍后重试");

    expect(runtimeMocks.loggerError).toHaveBeenCalledWith(
      {
        event: "marketing_sla_visibility_update_failed",
        safeCode: "unexpected_failure",
      },
      "Homepage SLA visibility update failed"
    );
    expect(JSON.stringify(runtimeMocks.loggerError.mock.calls)).not.toMatch(
      /password@example|Bearer|token-canary|SELECT|api_key|key-canary|stack-canary/
    );
  });
});
