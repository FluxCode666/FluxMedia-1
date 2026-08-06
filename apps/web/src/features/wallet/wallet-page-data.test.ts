/**
 * 钱包页面数据聚合测试。
 *
 * 证明余额、最近订单和一次性充值能力并行读取且独立失败，充值关闭不会被误判
 * 为读取异常。
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

/** 创建指定充值开关的钱包 loader。 */
function createLoaders(topUpEnabled: boolean) {
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
  };
}

describe("loadWalletPageData", () => {
  it.each([false, true])("保留充值=%s 的快照", async (topUp) => {
    const result = await loadWalletPageData(createLoaders(topUp));

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
  });

  it("隔离余额与购买能力失败，不把异常伪装为关闭或零余额", async () => {
    const loaders = createLoaders(false);
    loaders.loadBalance.mockRejectedValue(new Error("balance unavailable"));
    loaders.loadRecentOrders.mockRejectedValue(
      new Error("recent orders unavailable")
    );
    loaders.loadTopUp.mockRejectedValue(new Error("top-up unavailable"));

    const result = await loadWalletPageData(loaders);

    expect(result.balance).toEqual({ status: "error" });
    expect(result.recentOrders).toEqual({ status: "error" });
    expect(result.topUp).toEqual({ status: "error" });
  });
});
