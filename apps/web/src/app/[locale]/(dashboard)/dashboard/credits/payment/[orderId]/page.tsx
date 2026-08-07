/**
 * 统一积分支付结果页路由。
 *
 * 使用方：支付宝二维码下单、易支付与 Creem 的成功回跳。
 * 页面只负责承载客户端轮询视图；订单归属校验和积分履约均在服务端完成。
 */
import type { Metadata } from "next";
import { Suspense } from "react";

import CreditPaymentResultLoading from "./loading";
import { CreditPaymentResultView } from "./payment-result-view";

export const metadata: Metadata = {
  title: "Payment Status",
  description: "Track payment confirmation and credit delivery",
};

/** 渲染指定支付订单的客户端状态视图。 */
export default async function CreditPaymentResultPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  return (
    <Suspense fallback={<CreditPaymentResultLoading />}>
      <CreditPaymentResultView orderId={orderId} />
    </Suspense>
  );
}
