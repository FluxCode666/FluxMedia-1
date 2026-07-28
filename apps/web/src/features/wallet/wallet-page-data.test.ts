/**
 * 钱包页面数据聚合测试。
 *
 * 证明余额、最近订单、充值与订阅能力并行读取且独立失败，主动关闭不会被误判为
 * 读取异常。
 */
import { describe, expect, it, vi } from "vitest";

import { loadWalletPageData } from "./wallet-page-data";

const BALANCE = {
  balance: 500,
  totalSpent: 100,
  totalRefunded: 30,
  totalNetSpent: 70,
  status: "active" as const,
  asOf: "2026-07-22T01:00:00.000Z",
};

/** 创建指定充值/订阅开关的钱包 loader。 */
function createLoaders(topUpEnabled: boolean, subscriptionEnabled: boolean) {
  return {
    loadBalance: vi.fn().mockResolvedValue(BALANCE),
    loadRecentOrders: vi.fn().mockResolvedValue({
      asOf: "2026-07-22T01:00:00.000Z",
      timeZone: "UTC",
      records: [],
    }),
    loadTopUp: vi.fn().mockResolvedValue({
      enabled: topUpEnabled,
      defaultCurrency: "CNY",
      currencies: topUpEnabled
        ? [
            {
              currency: "CNY",
              creditsPerMajorUnit: 10,
              minAmountMinor: 100,
              maxAmountMinor: 100_000,
              providers: ["alipay_f2f" as const],
            },
          ]
        : [],
    }),
    loadSubscription: vi.fn().mockResolvedValue({
      enabled: subscriptionEnabled,
      currentPlan: "free" as const,
      currency: "CNY",
      plans: [],
    }),
  };
}

describe("loadWalletPageData", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("保留充值=%s、订阅=%s 的四态快照", async (topUp, subscription) => {
    const result = await loadWalletPageData(createLoaders(topUp, subscription));

    expect(result.balance).toEqual({ status: "ready", data: BALANCE });
    expect(result.recentOrders).toEqual({
      status: "ready",
      data: {
        asOf: "2026-07-22T01:00:00.000Z",
        timeZone: "UTC",
        records: [],
      },
    });
    expect(result.topUp).toMatchObject({
      status: "ready",
      data: { enabled: topUp },
    });
    expect(result.subscription).toMatchObject({
      status: "ready",
      data: { enabled: subscription },
    });
  });

  it("隔离余额与购买能力失败，不把异常伪装为关闭或零余额", async () => {
    const loaders = createLoaders(false, true);
    loaders.loadBalance.mockRejectedValue(new Error("balance unavailable"));
    loaders.loadRecentOrders.mockRejectedValue(
      new Error("recent orders unavailable")
    );
    loaders.loadTopUp.mockRejectedValue(new Error("top-up unavailable"));

    const result = await loadWalletPageData(loaders);

    expect(result.balance).toEqual({ status: "error" });
    expect(result.recentOrders).toEqual({ status: "error" });
    expect(result.topUp).toEqual({ status: "error" });
    expect(result.subscription).toMatchObject({
      status: "ready",
      data: { enabled: true },
    });
  });

  it("区分订阅主动关闭与 provider 配置读取异常", async () => {
    const loaders = createLoaders(false, false);
    loaders.loadSubscription.mockRejectedValue(
      new Error("provider settings unavailable")
    );

    const result = await loadWalletPageData(loaders);

    expect(result.topUp).toMatchObject({
      status: "ready",
      data: { enabled: false },
    });
    expect(result.recentOrders).toMatchObject({ status: "ready" });
    expect(result.subscription).toEqual({ status: "error" });
  });
});
