/**
 * 钱包页面三块数据的并行聚合器。
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

export type {
  WalletBalanceSnapshot,
  WalletTopUpOptions,
} from "@repo/shared/credits/wallet-contract";

/** 单块钱包数据的显式成功/失败状态。 */
export type WalletDataSection<T> =
  | { status: "ready"; data: T }
  | { status: "error" };

/** 钱包页面三块独立数据。 */
export type WalletPageData = {
  balance: WalletDataSection<WalletBalanceSnapshot>;
  recentOrders: WalletDataSection<UserPaymentOrderListOutput>;
  topUp: WalletDataSection<WalletTopUpOptions>;
};

/** 钱包 loader 依赖；生产调用方必须让三个函数经过本人 UOL。 */
export type WalletPageDataLoaders = {
  loadBalance: () => Promise<WalletBalanceSnapshot>;
  loadRecentOrders: () => Promise<UserPaymentOrderListOutput>;
  loadTopUp: () => Promise<WalletTopUpOptions>;
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
 * 并行加载钱包余额、最近充值订单和一次性充值能力。
 *
 * @param loaders 三个本人 UOL loader。
 * @returns 三块相互隔离的结果；任一失败不会改写其他数据块的业务状态。
 */
export async function loadWalletPageData(
  loaders: WalletPageDataLoaders
): Promise<WalletPageData> {
  const [balance, recentOrders, topUp] = await Promise.allSettled([
    loaders.loadBalance(),
    loaders.loadRecentOrders(),
    loaders.loadTopUp(),
  ]);
  return {
    balance: toWalletDataSection("balance", balance),
    recentOrders: toWalletDataSection("recentOrders", recentOrders),
    topUp: toWalletDataSection("topUp", topUp),
  };
}
