/**
 * 支付履约恢复 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶。权限已由 operation 的 cronJob 声明统一限制，本绑定
 * 只把传输无关 operation 接到支付恢复服务。
 */
import { bindOperationExecute } from "@repo/shared/uol";
import { recoverPaymentFulfillments } from "@repo/shared/uol/operations/payment-fulfillment";

import { runPaymentFulfillmentRecovery } from "@/features/payment/payment-fulfillment-service";

bindOperationExecute(recoverPaymentFulfillments, async () =>
  runPaymentFulfillmentRecovery()
);
