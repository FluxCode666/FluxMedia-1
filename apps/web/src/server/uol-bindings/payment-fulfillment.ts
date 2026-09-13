/**
 * 支付履约恢复 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶。权限已由 operation 的 cronJob 声明统一限制，本绑定
 * 只把传输无关 operation 接到支付恢复服务。
 */
import { bindOperationExecute } from "@repo/shared/uol";
import { recoverPaymentFulfillments } from "@repo/shared/uol/operations/payment-fulfillment";
import { requestGoJson } from "@/server/go-backend-client";

bindOperationExecute(recoverPaymentFulfillments, async () => {
  const token = process.env.CRON_SECRET?.trim();
  return requestGoJson<{
    expiredEventCount: number;
    claimedCount: number;
    succeededCount: number;
    retryCount: number;
    failedCount: number;
    supersededCount: number;
  }>("/api/internal/payment-fulfillment/recover", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: "{}",
  });
});
