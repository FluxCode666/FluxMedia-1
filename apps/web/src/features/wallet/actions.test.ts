/**
 * 钱包 Server Action 薄适配测试。
 *
 * 证明三块数据只从当前会话构造 user Principal，并原样返回 UOL 输出。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  getUserRoleById: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("@repo/shared/safe-action", () => ({
  protectedAction: {
    metadata: () => ({
      action:
        <T>(handler: (input: { ctx: { userId: string } }) => Promise<T>) =>
        (input: { ctx: { userId: string } }) =>
          handler(input),
    }),
  },
}));

vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getUserRoleById,
}));

vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));

vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import {
  getMyWalletBalanceAction,
  getMyWalletPageDataAction,
  getMyWalletRecentPaymentOrdersAction,
  getMyWalletTopUpOptionsAction,
} from "./actions";

type MockAction = (input: { ctx: { userId: string } }) => Promise<unknown>;

describe("wallet actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
    mocks.getUserRoleById.mockResolvedValue("user");
  });

  it.each([
    [getMyWalletBalanceAction, "credits.getMyBalance"],
    [getMyWalletTopUpOptionsAction, "credits.getTopUpOptions"],
    [getMyWalletRecentPaymentOrdersAction, "payment.listMyRecentOrders"],
  ] as const)("%s 仅以本人 Principal 调用 %s", async (action, operation) => {
    const output = { marker: operation };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (action as unknown as MockAction)({ ctx: { userId: "session-user" } })
    ).resolves.toBe(output);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      operation,
      {},
      {
        type: "user",
        userId: "session-user",
        role: "user",
      }
    );
  });

  it("首屏聚合只读取一次角色并隔离三块 UOL 结果", async () => {
    mocks.invokeOperation.mockImplementation(async (operation: string) => {
      if (operation === "credits.getTopUpOptions") {
        throw new Error("top-up unavailable");
      }
      return { operation };
    });

    const result = await (getMyWalletPageDataAction as unknown as MockAction)({
      ctx: { userId: "session-user" },
    });

    expect(mocks.ensureUolInitialized).toHaveBeenCalledTimes(1);
    expect(mocks.getUserRoleById).toHaveBeenCalledTimes(1);
    expect(mocks.invokeOperation).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      balance: { status: "ready" },
      recentOrders: { status: "ready" },
      topUp: { status: "error" },
    });
  });
});
