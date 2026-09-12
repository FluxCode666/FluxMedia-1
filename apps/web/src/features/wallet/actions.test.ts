/**
 * 钱包 Server Action 薄适配测试。
 *
 * 证明三块数据都通过 Go backend 读取，并原样返回后端输出。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestGoJson: vi.fn(),
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

vi.mock("@/server/go-backend-client", () => ({
  requestGoJson: mocks.requestGoJson,
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
    mocks.requestGoJson.mockResolvedValue({ marker: "credits.getTopUpOptions" });
  });

  it("最近充值订单通过 Go backend 读取", async () => {
    const output = { marker: "payment.listMyRecentOrders" };
    mocks.requestGoJson.mockResolvedValue(output);
    await expect(
      (getMyWalletRecentPaymentOrdersAction as unknown as MockAction)({
        ctx: { userId: "session-user" },
      })
    ).resolves.toBe(output);
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/credits/payment-orders");
  });

  it("余额通过 Go backend 读取", async () => {
    const output = { marker: "credits.getMyBalance" };
    mocks.requestGoJson.mockResolvedValue(output);

    await expect(
      (getMyWalletBalanceAction as unknown as MockAction)({
        ctx: { userId: "session-user" },
      })
    ).resolves.toBe(output);
    expect(mocks.requestGoJson).toHaveBeenCalledWith("/api/credits/balance");
  });

  it("充值选项通过 Go backend 读取", async () => {
    const output = { marker: "credits.getTopUpOptions" };
    mocks.requestGoJson.mockResolvedValue(output);

    await expect(
      (getMyWalletTopUpOptionsAction as unknown as MockAction)({
        ctx: { userId: "session-user" },
      })
    ).resolves.toBe(output);
    expect(mocks.requestGoJson).toHaveBeenCalledWith(
      "/api/credits/top-up/options"
    );
  });

  it("首屏聚合通过 Go backend 并隔离三块结果", async () => {
    mocks.requestGoJson.mockImplementation(async (path: string) => {
      if (path === "/api/credits/top-up/options") {
        throw new Error("top-up unavailable");
      }
      return { operation: path };
    });

    const result = await (getMyWalletPageDataAction as unknown as MockAction)({
      ctx: { userId: "session-user" },
    });

    expect(mocks.requestGoJson).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      balance: { status: "ready" },
      recentOrders: { status: "ready" },
      topUp: { status: "error" },
    });
  });
});
