/**
 * Epay webhook 薄适配器。
 *
 * 使用方：易支付同步或异步通知。路由只检查运行时配置、解析并验签、过滤成功事件，
 * 然后构造严格 webhook Principal 调用 UOL；订单和积分履约不在传输层执行。
 */
import { withApiLogging } from "@repo/shared/api-logger";
import { logError, logger } from "@repo/shared/logger";
import {
  EPAY_TRADE_SUCCESS,
  isRuntimeEpayConfigured,
  parseEpayRequestParams,
  verifyRuntimeEpayParams,
} from "@repo/shared/payment/epay";
import { invokeOperation } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

export const GET = withApiLogging(handleEpayWebhook);
export const POST = withApiLogging(handleEpayWebhook);

/** 验证 Epay 通知并把成功事件转交统一接口层。 */
async function handleEpayWebhook(req: Request): Promise<Response> {
  if (!(await isRuntimeEpayConfigured())) {
    logger.warn({ source: "epay-webhook" }, "Epay is not configured");
    return new Response("fail", { status: 200 });
  }

  const params = await parseEpayRequestParams(req);
  const verifyInfo = await verifyRuntimeEpayParams(params);

  if (!verifyInfo.verifyStatus) {
    logger.warn(
      { source: "epay-webhook", outTradeNo: verifyInfo.outTradeNo },
      "Invalid Epay signature"
    );
    return new Response("fail", { status: 200 });
  }

  if (verifyInfo.tradeStatus !== EPAY_TRADE_SUCCESS) {
    logger.info(
      {
        source: "epay-webhook",
        outTradeNo: verifyInfo.outTradeNo,
        tradeStatus: verifyInfo.tradeStatus,
      },
      "Ignoring non-success Epay event"
    );
    return new Response("success", { status: 200 });
  }

  try {
    await ensureUolInitialized();
    await invokeOperation(
      "credits.fulfillEpayTopUp",
      {
        type: verifyInfo.type,
        tradeNo: verifyInfo.tradeNo,
        outTradeNo: verifyInfo.outTradeNo,
        name: verifyInfo.name,
        money: verifyInfo.money,
        tradeStatus: verifyInfo.tradeStatus,
        ...(verifyInfo.param !== undefined ? { param: verifyInfo.param } : {}),
      },
      { type: "webhook", provider: "epay" }
    );
  } catch (error) {
    logError(error, {
      source: "epay-webhook",
      outTradeNo: verifyInfo.outTradeNo,
    });
    return new Response("fail", { status: 200 });
  }

  return new Response("success", { status: 200 });
}
