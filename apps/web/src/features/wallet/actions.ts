"use server";

/**
 * 钱包 Server Action 薄传输适配器。
 *
 * 使用方：钱包页面。各 Action 只初始化 UOL、从 session 构造本人 Principal
 * 并调用 operation；不读取数据库、不合并错误，也不接受 userId。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import type { UserPaymentOrderListOutput } from "@repo/shared/payment/user-order-contract";
import { protectedAction } from "@repo/shared/safe-action";
import { invokeOperation, type Principal } from "@repo/shared/uol";
import { ensureUolInitialized } from "@/server/uol-init";
import type {
  WalletBalanceSnapshot,
  WalletTopUpOptions,
} from "./wallet-page-data";
import { loadWalletPageData } from "./wallet-page-data";

type WalletOperationOutputs = {
  "credits.getMyBalance": WalletBalanceSnapshot;
  "credits.getTopUpOptions": WalletTopUpOptions;
  "payment.listMyRecentOrders": UserPaymentOrderListOutput;
};
type WalletOperationName = keyof WalletOperationOutputs;

/** 初始化 UOL 并为当前 session 构造一次 user Principal。 */
async function createMyWalletPrincipal(userId: string): Promise<Principal> {
  await ensureUolInitialized();
  const role = await getUserRoleById(userId);
  return { type: "user", userId, role };
}

/** 使用已验证的 user Principal 调用类型绑定的无输入钱包 operation。 */
async function invokeWalletOperation<N extends WalletOperationName>(
  name: N,
  principal: Principal
): Promise<WalletOperationOutputs[N]> {
  return invokeOperation<WalletOperationOutputs[N]>(name, {}, principal);
}

/** 为单项重试 Action 构造当前 Principal 后调用钱包 operation。 */
async function invokeMyWalletOperation<N extends WalletOperationName>(
  name: N,
  userId: string
): Promise<WalletOperationOutputs[N]> {
  return invokeWalletOperation(name, await createMyWalletPrincipal(userId));
}

/** 读取当前用户钱包余额快照。 */
export const getMyWalletBalanceAction = protectedAction
  .metadata({ action: "credits.getMyBalance" })
  .action(async ({ ctx }) =>
    invokeMyWalletOperation("credits.getMyBalance", ctx.userId)
  );

/** 读取当前用户有效充值能力。 */
export const getMyWalletTopUpOptionsAction = protectedAction
  .metadata({ action: "credits.getTopUpOptions" })
  .action(async ({ ctx }) =>
    invokeMyWalletOperation("credits.getTopUpOptions", ctx.userId)
  );

/** 读取当前用户最近创建的积分充值订单。 */
export const getMyWalletRecentPaymentOrdersAction = protectedAction
  .metadata({ action: "payment.listMyRecentOrders" })
  .action(async ({ ctx }) =>
    invokeMyWalletOperation("payment.listMyRecentOrders", ctx.userId)
  );

/**
 * 一次鉴权并行加载钱包三块数据，供首屏使用。
 *
 * 单块 UOL 失败由聚合器转换为独立 error 状态；不会把读取异常伪装成关闭。
 */
export const getMyWalletPageDataAction = protectedAction
  .metadata({ action: "wallet.getMyPageData" })
  .action(async ({ ctx }) => {
    const principal = await createMyWalletPrincipal(ctx.userId);
    return loadWalletPageData({
      loadBalance: () =>
        invokeWalletOperation("credits.getMyBalance", principal),
      loadRecentOrders: () =>
        invokeWalletOperation("payment.listMyRecentOrders", principal),
      loadTopUp: () =>
        invokeWalletOperation("credits.getTopUpOptions", principal),
    });
  });
