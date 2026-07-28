/**
 * 用户侧支付 UOL 真实执行绑定。
 *
 * 使用方：uol-bindings.ts 启动副作用导入。所有订单查询身份只从 user Principal
 * 派生，不接受客户端 userId，避免通过订单列表产生 IDOR。
 */
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { bindOperationExecute, OperationError } from "@repo/shared/uol";
import { listMyRecentPaymentOrders } from "@repo/shared/uol/operations/payment";

import {
  databaseUserPaymentOrderRepository,
  loadUserRecentPaymentOrders,
} from "@/features/payment/user-payment-orders";

/** 绑定本人最近充值订单查询，并在仓储前拒绝非会话 Principal。 */
bindOperationExecute(listMyRecentPaymentOrders, async (input, principal) => {
  if (principal.type !== "user") {
    throw new OperationError(
      "unauthenticated",
      "User session authentication required"
    );
  }
  return loadUserRecentPaymentOrders(
    {
      userId: principal.userId,
      input,
      timeZone: await getUserTimeZone(principal.userId),
    },
    { repository: databaseUserPaymentOrderRepository }
  );
});
