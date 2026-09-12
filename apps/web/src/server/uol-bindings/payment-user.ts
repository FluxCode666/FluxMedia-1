/**
 * 用户侧支付 UOL 真实执行绑定。
 *
 * 使用方：uol-bindings.ts 启动副作用导入。所有订单查询身份只从 user Principal
 * 派生，不接受客户端 userId，避免通过订单列表产生 IDOR。
 */
import type { UserPaymentOrderListOutput } from "@repo/shared/payment/user-order-contract";
import { bindOperationExecute, OperationError } from "@repo/shared/uol";
import { listMyRecentPaymentOrders } from "@repo/shared/uol/operations/payment";
import { requestGoJson } from "@/server/go-backend-client";

/** 绑定本人最近充值订单查询，并在仓储前拒绝非会话 Principal。 */
bindOperationExecute(listMyRecentPaymentOrders, async (input, principal) => {
  if (principal.type !== "user") {
    throw new OperationError(
      "unauthenticated",
      "User session authentication required"
    );
  }
  const limit = input.limit ?? 8;
  return requestGoJson<UserPaymentOrderListOutput>(
    `/api/credits/payment-orders?limit=${encodeURIComponent(String(limit))}`
  );
});
