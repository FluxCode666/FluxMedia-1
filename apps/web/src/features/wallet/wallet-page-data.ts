/**
 * 钱包页面四块数据的并行聚合器。
 *
 * 使用方：钱包 Server Component。关键依赖由调用方注入，避免页面绕过 UOL。
 * 每块结果独立表达 ready/error，禁止用零余额或 disabled 掩盖读取异常。
 */

import type {
  WalletBalanceSnapshot,
  WalletTopUpOptions,
} from "@repo/shared/credits/wallet-contract";
import { logError } from "@repo/shared/logger";
import type { UserPaymentOrderListOutput } from "@repo/shared/payment/user-order-contract";
import type { SubscriptionPurchaseOptions } from "@repo/shared/subscription/purchase-contract";

export type {
  WalletBalanceSnapshot,
  WalletTopUpOptions,
} from "@repo/shared/credits/wallet-contract";

/** 单块钱包数据的显式成功/失败状态。 */
export type WalletDataSection<T> =
  | { status: "ready"; data: T }
  | { status: "error" };

/** 钱包页面四块独立数据。 */
export type WalletPageData = {
  balance: WalletDataSection<WalletBalanceSnapshot>;
  recentOrders: WalletDataSection<UserPaymentOrderListOutput>;
  topUp: WalletDataSection<WalletTopUpOptions>;
  subscription: WalletDataSection<SubscriptionPurchaseOptions>;
};

/** 钱包 loader 依赖；生产调用方必须让四个函数经过本人 UOL。 */
export type WalletPageDataLoaders = {
  loadBalance: () => Promise<WalletBalanceSnapshot>;
  loadRecentOrders: () => Promise<UserPaymentOrderListOutput>;
  loadTopUp: () => Promise<WalletTopUpOptions>;
  loadSubscription: () => Promise<SubscriptionPurchaseOptions>;
};

/**
 * 把 Promise.allSettled 结果转换为不携带内部异常的数据块。
 *
 * @param result 单个 loader 的完成结果。
 * @returns ready 数据或无详情 error，失败不会污染其他数据块。
 */
function toWalletDataSection<T>(
  section: keyof WalletPageData,
  result: PromiseSettledResult<T>
): WalletDataSection<T> {
  if (result.status === "fulfilled") {
    return { status: "ready", data: result.value };
  }
  logError(result.reason, { source: "wallet-page", section });
  return { status: "error" };
}

/**
 * 并行加载钱包余额、最近充值订单、充值能力和订阅能力。
 *
 * @param loaders 四个本人 UOL loader。
 * @returns 四块相互隔离的结果；任一失败不会改写其他数据块的业务状态。
 */
export async function loadWalletPageData(
  loaders: WalletPageDataLoaders
): Promise<WalletPageData> {
  const [balance, recentOrders, topUp, subscription] = await Promise.allSettled(
    [
      loaders.loadBalance(),
      loaders.loadRecentOrders(),
      loaders.loadTopUp(),
      loaders.loadSubscription(),
    ]
  );
  return {
    balance: toWalletDataSection("balance", balance),
    recentOrders: toWalletDataSection("recentOrders", recentOrders),
    topUp: toWalletDataSection("topUp", topUp),
    subscription: toWalletDataSection("subscription", subscription),
  };
}
