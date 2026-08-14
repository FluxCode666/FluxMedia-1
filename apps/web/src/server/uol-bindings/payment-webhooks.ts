/**
 * 支付 webhook UOL 真实绑定。
 *
 * 使用方：uol-bindings 启动桶。传输层完成渠道验签后只提交规范化通知；本文件将其
 * 适配到现有支付履约服务，订单快照、金额、幂等和持久工作项仍由领域服务负责。
 */
import type { EpayVerifyResult } from "@repo/shared/payment/epay";
import { bindOperationExecute } from "@repo/shared/uol";
import { fulfillEpayTopUp } from "@repo/shared/uol/operations";

import { fulfillSuccessfulEpayPayment } from "@/features/payment/epay-fulfillment";

bindOperationExecute(fulfillEpayTopUp, async (input) => {
  const verifyInfo: EpayVerifyResult = {
    ...input,
    verifyStatus: true,
    raw: {},
  };
  const result = await fulfillSuccessfulEpayPayment(verifyInfo, "epay-webhook");
  return { metadataType: result.metadata.type };
});
