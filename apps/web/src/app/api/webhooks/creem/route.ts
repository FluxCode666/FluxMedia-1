/**
 * Creem webhook 薄适配器。
 *
 * 使用方：Creem 已验签事件通知。路由只读取签名、解析事件、过滤已退役事件并把
 * credit_purchase Checkout 的最小字段交给 UOL；订单、积分和推广履约均不在此执行。
 */
import { withApiLogging } from "@repo/shared/api-logger";
import { logError, logger } from "@repo/shared/logger";
import {
  type CreemCheckoutCompletedData,
  type CreemWebhookEvent,
  constructRuntimeCreemEvent,
} from "@repo/shared/payment/creem";
import { invokeOperation } from "@repo/shared/uol";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { ensureUolInitialized } from "@/server/uol-init";

/** 从已验签 Checkout 提取 UOL 所需最小字段，不转发原始 payload 或签名。 */
function buildCreemTopUpInput(
  data: CreemCheckoutCompletedData,
  createdAt: number
) {
  const metadata = data.metadata;
  return {
    checkoutId: data.id,
    ...(data.request_id ? { requestId: data.request_id } : {}),
    customerId: data.customer.id,
    ...(metadata?.userId ? { userId: metadata.userId } : {}),
    ...(metadata?.paymentOrderId
      ? { paymentOrderId: metadata.paymentOrderId }
      : {}),
    ...(metadata?.packageId ? { packageId: metadata.packageId } : {}),
    ...(data.order
      ? {
          order: {
            id: data.order.id,
            amount: data.order.amount,
            currency: data.order.currency,
            ...(data.order.product ? { productId: data.order.product } : {}),
          },
        }
      : {}),
    ...(data.product
      ? {
          product: {
            id: data.product.id,
            ...(data.product.billing_type
              ? { billingType: data.product.billing_type }
              : {}),
          },
        }
      : {}),
    createdAt,
  };
}

/** 记录已验签但无需履约的事件，并避免原始请求与签名进入日志。 */
function logIgnoredCreemEvent(
  event: CreemWebhookEvent,
  requestId?: string
): void {
  const eventId = event.id.slice(0, 128);
  const sanitizedRequestId = requestId?.slice(0, 128);
  logger.info(
    {
      provider: "creem",
      eventType: event.eventType,
      eventId,
      ...(sanitizedRequestId ? { requestId: sanitizedRequestId } : {}),
    },
    "Ignored retired subscription webhook"
  );
}

/** 验证并分派单条 Creem webhook；履约失败返回 5xx 触发渠道重投。 */
async function handleCreemWebhook(req: Request): Promise<NextResponse> {
  const body = await req.text();
  const headersList = await headers();
  const signature = headersList.get("creem-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing creem-signature header" },
      { status: 400 }
    );
  }

  let event: CreemWebhookEvent;
  try {
    event = await constructRuntimeCreemEvent(body, signature);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logError(error, { source: "creem-webhook", stage: "signature" });
    return NextResponse.json(
      { error: `Webhook Error: ${errorMessage}` },
      { status: 400 }
    );
  }

  try {
    switch (event.eventType) {
      case "checkout.completed": {
        const data = event.object as CreemCheckoutCompletedData;
        if (data.metadata?.type !== "credit_purchase") {
          logIgnoredCreemEvent(event, data.request_id);
          break;
        }
        await ensureUolInitialized();
        await invokeOperation(
          "credits.fulfillCreemTopUp",
          buildCreemTopUpInput(data, event.created_at),
          { type: "webhook", provider: "creem" }
        );
        break;
      }
      case "subscription.active":
      case "subscription.renewed":
      case "subscription.paid":
      case "subscription.canceled":
      case "subscription.past_due":
      case "subscription.paused":
      case "subscription.expired": {
        logIgnoredCreemEvent(event);
        break;
      }
      default:
        logger.info({ eventType: event.eventType }, "Unhandled event type");
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    logError(error, { source: "creem-webhook", stage: "handler" });
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}

export const POST = withApiLogging(handleCreemWebhook);
