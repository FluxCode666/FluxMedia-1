/**
 * 支付宝当面付异步通知路由。
 *
 * 职责：限制为表单 POST、使用官方 SDK 验签、构造 webhook Principal 后调用 UOL。
 * 使用方：支付宝开放平台的 notify_url。
 *
 * 安全边界：此路由不直接读写积分；验签只证明请求来源，订单金额、App ID、卖家、
 * 过期时间和幂等履约全部在 credits.fulfillAlipayTopUp 操作中再次校验。
 */
import { withApiLogging } from "@repo/shared/api-logger";
import { logError, logger } from "@repo/shared/logger";
import {
  isRuntimeAlipayF2FConfigured,
  parseAlipayNotificationParams,
  verifyRuntimeAlipayNotification,
} from "@repo/shared/payment/alipay-f2f";
import { invokeOperation } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

export const POST = withApiLogging(handleAlipayWebhook);

async function handleAlipayWebhook(req: Request) {
  if (!(await isRuntimeAlipayF2FConfigured())) {
    logger.warn({ source: "alipay-webhook" }, "Alipay F2F is not configured");
    return new Response("failure", { status: 503 });
  }

  let params: Record<string, string>;
  try {
    params = await parseAlipayNotificationParams(req);
  } catch (error) {
    logError(error, { source: "alipay-webhook", stage: "parse" });
    return new Response("failure", { status: 400 });
  }

  let verified = false;
  try {
    verified = await verifyRuntimeAlipayNotification(params);
  } catch (error) {
    logError(error, { source: "alipay-webhook", stage: "verify" });
    return new Response("failure", { status: 400 });
  }
  if (!verified) {
    logger.warn(
      { source: "alipay-webhook", outTradeNo: params.out_trade_no },
      "Invalid Alipay notification signature"
    );
    return new Response("failure", { status: 400 });
  }
  if (!params.seller_id) {
    logger.warn(
      { source: "alipay-webhook", outTradeNo: params.out_trade_no },
      "Alipay notification is missing seller_id"
    );
    return new Response("failure", { status: 400 });
  }

  try {
    await ensureUolInitialized();
    await invokeOperation(
      "credits.fulfillAlipayTopUp",
      {
        outTradeNo: params.out_trade_no,
        tradeNo: params.trade_no,
        tradeStatus: params.trade_status,
        totalAmount: params.total_amount,
        appId: params.app_id,
        sellerId: params.seller_id,
        gmtPayment: params.gmt_payment,
      },
      { type: "webhook", provider: "alipay" }
    );
  } catch (error) {
    logError(error, {
      source: "alipay-webhook",
      stage: "fulfill",
      outTradeNo: params.out_trade_no,
    });
    return new Response("failure", { status: 500 });
  }

  return new Response("success");
}
