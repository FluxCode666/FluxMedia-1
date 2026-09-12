"use server";

/**
 * 钱包 Server Action 薄传输适配器。
 *
 * 使用方：钱包页面。各 Action 只把当前会话转发到 Go backend；不读取数据库、
 * 不合并错误，也不接受 userId。
 */
import type { UserPaymentOrderListOutput } from "@repo/shared/payment/user-order-contract";
import { protectedAction } from "@repo/shared/safe-action";
import type {
  WalletBalanceSnapshot,
  WalletTopUpOptions,
} from "./wallet-page-data";
import { loadWalletPageData } from "./wallet-page-data";
import { requestGoJson } from "@/server/go-backend-client";

/** 读取当前用户钱包余额快照。 */
export const getMyWalletBalanceAction = protectedAction
  .metadata({ action: "credits.getMyBalance" })
  .action(async () => requestGoJson<WalletBalanceSnapshot>("/api/credits/balance"));

/** 读取当前用户有效充值能力。 */
export const getMyWalletTopUpOptionsAction = protectedAction
  .metadata({ action: "credits.getTopUpOptions" })
  .action(async () =>
    requestGoJson<WalletTopUpOptions>("/api/credits/top-up/options")
  );

/** 读取当前用户最近创建的积分充值订单。 */
export const getMyWalletRecentPaymentOrdersAction = protectedAction
  .metadata({ action: "payment.listMyRecentOrders" })
  .action(async () =>
    requestGoJson<UserPaymentOrderListOutput>("/api/credits/payment-orders")
  );

/**
 * 一次鉴权并行加载钱包三块数据，供首屏使用。
 *
 * 单块 UOL 失败由聚合器转换为独立 error 状态；不会把读取异常伪装成关闭。
 */
export const getMyWalletPageDataAction = protectedAction
  .metadata({ action: "wallet.getMyPageData" })
  .action(async () =>
    loadWalletPageData({
      loadBalance: () => requestGoJson<WalletBalanceSnapshot>("/api/credits/balance"),
      loadRecentOrders: () =>
        requestGoJson<UserPaymentOrderListOutput>("/api/credits/payment-orders"),
      loadTopUp: () =>
        requestGoJson<WalletTopUpOptions>("/api/credits/top-up/options"),
    })
  );
