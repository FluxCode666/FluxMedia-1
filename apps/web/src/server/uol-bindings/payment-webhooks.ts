/**
 * 支付 webhook UOL 真实绑定。
 *
 * 使用方：uol-bindings 启动桶。传输层完成渠道验签后只提交规范化通知；本文件将其
 * 适配到现有支付履约服务，订单快照、金额、幂等和持久工作项仍由领域服务负责。
 */
import { bindOperationExecute } from "@repo/shared/uol";
import {
  fulfillCreemTopUp,
  fulfillEpayTopUp,
} from "@repo/shared/uol/operations";
import { requestGoJson } from "@/server/go-backend-client";

function internalHeaders(): HeadersInit {
  const token = process.env.CRON_SECRET?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 将规范化 Epay operation 输入适配为现有已验签履约服务参数。 */
bindOperationExecute(fulfillEpayTopUp, async (input) => {
  return requestGoJson<{ metadataType: "credit_purchase" | "subscription" }>(
    "/api/internal/payment-fulfillment/epay",
    {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify(input),
    }
  );
});

/** 将最小 Creem Checkout 通知交给领域履约服务。 */
bindOperationExecute(fulfillCreemTopUp, async (input) => {
  return requestGoJson<{ processed: true }>(
    "/api/internal/payment-fulfillment/creem",
    {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify(input),
    }
  );
});
