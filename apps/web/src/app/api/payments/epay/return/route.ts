/**
 * Epay 浏览器同步回跳适配器。
 *
 * 使用方：Epay 支付完成后的浏览器跳转。此处只验证签名并读取本地履约状态；当前
 * 积分订单回结果页，历史订单回钱包；绝不发放积分或改变订单状态。
 */

import { getBaseUrl } from "@repo/shared/config/payment";
import { logger } from "@repo/shared/logger";
import {
  decodeEpayMetadata,
  EPAY_TRADE_SUCCESS,
  getEpayOrderMetadata,
  getEpayOrderStatus,
  isRuntimeEpayConfigured,
  parseEpayRequestParams,
  verifyRuntimeEpayParams,
} from "@repo/shared/payment/epay";
import { NextResponse } from "next/server";
import { createWalletPaymentResultUrl } from "@/features/wallet/redirects";

/** 处理 Epay GET 同步回跳。 */
export async function GET(req: Request) {
  return handleReturn(req);
}

/** 处理部分 Epay 网关使用的 POST 同步回跳。 */
export async function POST(req: Request) {
  return handleReturn(req);
}

/**
 * Epay 同步回跳页（浏览器可见）。
 *
 * 安全要点：此端点**仅用于展示**，绝不发放积分 / 履约订单。
 * 履约只在异步通知 /api/webhooks/epay 中进行——该回跳 URL 由网关带签名放入用户地址栏，
 * 用户可读取并并发重放，若在此发放积分将导致一次支付被多次履约（薅羊毛）。
 * 这里只校验签名用于展示真实状态，并读取本地订单状态反映履约进度。
 */
async function handleReturn(req: Request) {
  const baseUrl = getBaseUrl();

  if (!(await isRuntimeEpayConfigured())) {
    return NextResponse.redirect(createWalletPaymentResultUrl("fail", baseUrl));
  }

  const params = await parseEpayRequestParams(req);
  const verifyInfo = await verifyRuntimeEpayParams(params);
  const metadata = verifyInfo.verifyStatus
    ? (decodeEpayMetadata(verifyInfo.param) ??
      (await getEpayOrderMetadata(verifyInfo.outTradeNo)))
    : null;
  const creditResultPath =
    metadata?.type === "credit_purchase" && metadata.paymentOrderId
      ? `/${metadata.locale === "zh" ? "zh" : "en"}/dashboard/credits/payment/${encodeURIComponent(metadata.paymentOrderId)}`
      : null;
  if (!verifyInfo.verifyStatus) {
    logger.warn(
      { source: "epay-return", outTradeNo: verifyInfo.outTradeNo },
      "Invalid Epay return signature"
    );
    return NextResponse.redirect(createWalletPaymentResultUrl("fail", baseUrl));
  }

  // 仅读取本地订单状态以反映履约进度，不在此触发履约。
  const orderStatus = await getEpayOrderStatus(verifyInfo.outTradeNo);
  let payStatus: "success" | "processing" | "pending" | "fail" = "pending";
  if (orderStatus === "success") {
    payStatus = "success";
  } else if (orderStatus === "failed") {
    payStatus = "fail";
  } else if (
    orderStatus === "fulfilling" ||
    verifyInfo.tradeStatus === EPAY_TRADE_SUCCESS
  ) {
    // 网关已确认支付，但异步通知可能尚未完成履约。
    payStatus = "processing";
  }

  return NextResponse.redirect(
    creditResultPath
      ? `${baseUrl}${creditResultPath}?pay=${payStatus}`
      : createWalletPaymentResultUrl(payStatus, baseUrl)
  );
}
