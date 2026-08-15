/**
 * 积分包购买 Checkout 领域服务。
 *
 * 使用方：credits.createPurchaseCheckout UOL operation。服务通过显式依赖完成
 * 积分包校验、本地幂等订单创建与第三方 Checkout 编排，便于 DB-free 单元测试。
 * 关键依赖：调用方提供的支付配置、订单仓储和支付网关适配器。
 */

import type { RuntimeCreditPackage } from "./packages";
import type {
  CreditPackagePaymentOrder,
  CreditPackagePaymentProvider,
  CreditPackagePricingSnapshot,
} from "./purchase-orders";

/** 单次积分包购买允许的最大数量，Action 与 UOL schema 共用。 */
export const CREDIT_PACKAGE_PURCHASE_MAX_QUANTITY = 999;

/** 积分包购买 Checkout 的传输无关输入。 */
export type CreditPackagePurchaseCheckoutInput = {
  userId: string;
  packageId: string;
  clientRequestId: string;
  locale: "en" | "zh";
  quantity?: number;
};

/** 积分包购买 Checkout 的稳定输出；易支付必须成对返回 POST 方法与参数。 */
export type CreditPackagePurchaseCheckoutOutput =
  | {
      url: string;
      orderId: string;
    }
  | {
      url: string;
      orderId: string;
      params: Record<string, string>;
      method: "POST";
    };

/** 可安全投影到 UOL 和 Server Action 的预期业务错误。 */
export type CreditPackagePurchaseCheckoutErrorCode =
  | "invalid_package"
  | "quantity_not_supported"
  | "quantity_exceeded"
  | "invalid_amount"
  | "payment_disabled"
  | "unsupported_provider"
  | "provider_not_configured"
  | "provider_quantity_unsupported"
  | "provider_currency_unsupported"
  | "idempotency_conflict";

/**
 * 积分包购买的安全领域错误。
 *
 * message 只允许使用本模块定义的固定中文提示，不得包含数据库或第三方响应。
 */
export class CreditPackagePurchaseCheckoutError extends Error {
  readonly code: CreditPackagePurchaseCheckoutErrorCode;

  constructor(code: CreditPackagePurchaseCheckoutErrorCode, message: string) {
    super(message);
    this.name = "CreditPackagePurchaseCheckoutError";
    this.code = code;
  }
}

type CheckoutPaymentProvider =
  | CreditPackagePaymentProvider
  | "none"
  | "alipay_f2f";

type CreditPurchaseEpayMetadata = {
  type: "credit_purchase";
  userId: string;
  outTradeNo: string;
  paymentOrderId: string;
  locale: "en" | "zh";
  packageId: string;
  quantity: number;
  currency: string;
};

/** 领域服务依赖；生产适配与单元测试均必须显式提供完整实现。 */
export type CreditPackagePurchaseCheckoutDependencies = {
  getPackageById: (
    packageId: string
  ) => Promise<RuntimeCreditPackage | undefined>;
  isPackageVisible: (pkg: RuntimeCreditPackage) => boolean;
  getPackagePrice: (pkg: RuntimeCreditPackage) => number;
  getPackageCurrency: (pkg: RuntimeCreditPackage) => string;
  getPackageCreemProductId: (pkg: RuntimeCreditPackage) => string;
  getPaymentProvider: () => Promise<CheckoutPaymentProvider>;
  assertCreemConfigured: () => Promise<void>;
  getBaseUrl: () => string;
  getCreditsExpiryDays: () => Promise<number>;
  getCurrencyMinorUnitExponent: (currency: string) => number;
  createPaymentOrder: (input: {
    userId: string;
    clientRequestId: string;
    provider: CreditPackagePaymentProvider;
    currency: string;
    amount: number;
    amountMinor: number;
    creditsAmount: number;
    pricingSnapshot: CreditPackagePricingSnapshot;
    expiresAt: Date;
  }) => Promise<CreditPackagePaymentOrder>;
  saveEpayOrder: (
    metadata: CreditPurchaseEpayMetadata,
    totalPrice: number
  ) => Promise<void>;
  saveProviderReference: (input: {
    orderId: string;
    provider: CreditPackagePaymentProvider;
    providerPayload: Record<string, unknown>;
  }) => Promise<void>;
  createEpayPurchase: (input: {
    outTradeNo: string;
    name: string;
    money: number;
  }) => Promise<{ url: string; params: Record<string, string> }>;
  createCreemCheckout: (input: {
    product_id: string;
    success_url: string;
    request_id: string;
    metadata: Record<string, string>;
  }) => Promise<{ id: string; checkout_url: string }>;
  saveCheckout: (input: {
    orderId: string;
    provider: CreditPackagePaymentProvider;
    providerPayload: Record<string, unknown>;
    expiresAt: Date;
  }) => Promise<void>;
  failCheckout: (input: {
    orderId: string;
    provider: CreditPackagePaymentProvider;
  }) => Promise<void>;
  getCheckoutUrl: (payload: Record<string, unknown> | null) => string | null;
  logCheckoutStarted: (input: {
    userId: string;
    packageId: string;
    credits: number;
    quantity: number;
    provider: CheckoutPaymentProvider;
  }) => void;
  now: () => Date;
};

/**
 * 从本地订单 ID 派生稳定的易支付商户单号。
 *
 * @param orderId 数据库生成的本地支付订单 ID。
 * @returns 仅含字母数字且同一订单恒定的商户单号。
 * @throws 本地订单 ID 不含任何可用字符时抛出内部错误。
 */
function createStableEpayOutTradeNo(orderId: string): string {
  const normalizedOrderId = orderId.replaceAll(/[^a-zA-Z0-9]/g, "");
  if (!normalizedOrderId) throw new Error("积分包支付订单 ID 无效");
  return `CR${normalizedOrderId}`;
}

/** 将预期的订单幂等冲突转换为安全领域错误，其余仓储异常保持原样上抛。 */
function rethrowPaymentOrderError(error: unknown): never {
  if (
    error instanceof Error &&
    error.message === "该支付请求已用于另一份积分包"
  ) {
    throw new CreditPackagePurchaseCheckoutError(
      "idempotency_conflict",
      error.message
    );
  }
  throw error;
}

/**
 * 创建或重取当前用户的积分包购买 Checkout。
 *
 * @param input - 已由 UOL schema 校验的用户、积分包、幂等键、语言和数量。
 * @param dependencies - 支付配置、订单仓储与第三方网关实现。
 * @returns 本地订单 ID 和跳转地址；易支付同时返回 POST 表单参数。
 * @throws CreditPackagePurchaseCheckoutError 可预期且可安全展示的业务失败。
 * @throws Error 数据库、配置读取或第三方调用失败；由 UOL 网关统一隐藏细节。
 * @sideeffect 创建本地支付订单、记录支付事件，并可能调用支付供应商。
 */
export async function createCreditPackagePurchaseCheckout(
  input: CreditPackagePurchaseCheckoutInput,
  dependencies: CreditPackagePurchaseCheckoutDependencies
): Promise<CreditPackagePurchaseCheckoutOutput> {
  const requestedQuantity = input.quantity ?? 1;
  const pkg = await dependencies.getPackageById(input.packageId);
  if (!pkg || !dependencies.isPackageVisible(pkg)) {
    throw new CreditPackagePurchaseCheckoutError(
      "invalid_package",
      "无效的积分包"
    );
  }
  if (!pkg.allowQuantity && requestedQuantity !== 1) {
    throw new CreditPackagePurchaseCheckoutError(
      "quantity_not_supported",
      "该积分包不支持数量购买"
    );
  }

  const quantity = pkg.allowQuantity ? requestedQuantity : 1;
  if (pkg.maxQuantity && quantity > pkg.maxQuantity) {
    throw new CreditPackagePurchaseCheckoutError(
      "quantity_exceeded",
      `购买数量不能超过 ${pkg.maxQuantity}`
    );
  }

  const unitPrice = dependencies.getPackagePrice(pkg);
  const currency = dependencies.getPackageCurrency(pkg);
  const creditsAmount = pkg.credits * quantity;
  const totalPrice = unitPrice * quantity;
  const amountMinor = Math.round(
    totalPrice * 10 ** dependencies.getCurrencyMinorUnitExponent(currency)
  );
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new CreditPackagePurchaseCheckoutError(
      "invalid_amount",
      "积分包金额无效"
    );
  }

  const paymentProvider = await dependencies.getPaymentProvider();
  if (paymentProvider === "none") {
    throw new CreditPackagePurchaseCheckoutError(
      "payment_disabled",
      "支付功能当前未启用"
    );
  }
  if (paymentProvider === "alipay_f2f") {
    throw new CreditPackagePurchaseCheckoutError(
      "unsupported_provider",
      "支付宝当面付仅支持按金额充值，请在购买积分页使用支付宝扫码充值"
    );
  }

  const useEpay = paymentProvider === "epay";
  if (!useEpay) {
    try {
      await dependencies.assertCreemConfigured();
    } catch (error) {
      // WHY：只把明确的缺配置错误转换为用户提示；数据库超时等读取故障必须继续
      // 交给 UOL 网关分类，不能误报为管理员漏配支付通道。
      if (
        error instanceof Error &&
        error.message.includes("Creem 支付通道未完整配置")
      ) {
        throw new CreditPackagePurchaseCheckoutError(
          "provider_not_configured",
          "Creem 支付通道未完整配置，请联系管理员填写 API Key 和 Webhook Secret"
        );
      }
      throw error;
    }
  }
  if (!useEpay && quantity > 1) {
    throw new CreditPackagePurchaseCheckoutError(
      "provider_quantity_unsupported",
      "当前支付通道暂不支持数量购买，请分次购买"
    );
  }
  if (useEpay && currency !== "CNY") {
    throw new CreditPackagePurchaseCheckoutError(
      "provider_currency_unsupported",
      "易支付当前仅支持人民币积分包，请选择其他支付方式"
    );
  }

  dependencies.logCheckoutStarted({
    userId: input.userId,
    packageId: pkg.id,
    credits: creditsAmount,
    quantity,
    provider: paymentProvider,
  });

  const now = dependencies.now();
  const checkoutExpiry = new Date(now.getTime() + 30 * 60 * 1000);
  const creditsExpiryDays = await dependencies.getCreditsExpiryDays();
  const creditsExpiresAt =
    creditsExpiryDays > 0
      ? new Date(
          now.getTime() + creditsExpiryDays * 24 * 60 * 60 * 1000
        ).toISOString()
      : null;
  let paymentOrder: CreditPackagePaymentOrder;
  try {
    paymentOrder = await dependencies.createPaymentOrder({
      userId: input.userId,
      clientRequestId: input.clientRequestId,
      provider: useEpay ? "epay" : "creem",
      currency,
      amount: totalPrice,
      amountMinor,
      creditsAmount,
      pricingSnapshot: {
        packageId: pkg.id,
        quantity,
        currency,
        amountMinor,
        creditsAmount,
        creditsExpiresAt,
      },
      expiresAt: checkoutExpiry,
    });
  } catch (error) {
    rethrowPaymentOrderError(error);
  }

  const resultUrl = `${dependencies.getBaseUrl()}/${input.locale}/dashboard/credits/payment/${paymentOrder.id}`;
  if (paymentOrder.status === "fulfilled") {
    return { url: resultUrl, orderId: paymentOrder.id };
  }

  if (useEpay) {
    const existingOutTradeNo = paymentOrder.providerPayload?.outTradeNo;
    const outTradeNo =
      typeof existingOutTradeNo === "string" && existingOutTradeNo
        ? existingOutTradeNo
        : createStableEpayOutTradeNo(paymentOrder.id);
    const metadata: CreditPurchaseEpayMetadata = {
      type: "credit_purchase",
      userId: input.userId,
      outTradeNo,
      paymentOrderId: paymentOrder.id,
      locale: input.locale,
      packageId: pkg.id,
      quantity,
      currency,
    };
    await dependencies.saveEpayOrder(metadata, totalPrice);
    await dependencies.saveProviderReference({
      orderId: paymentOrder.id,
      provider: "epay",
      providerPayload: { outTradeNo },
    });
    try {
      const checkout = await dependencies.createEpayPurchase({
        outTradeNo,
        name:
          quantity > 1
            ? `FluxMedia Credits ${pkg.credits} x ${quantity}`
            : `FluxMedia Credits ${pkg.credits}`,
        money: totalPrice,
      });
      await dependencies.saveCheckout({
        orderId: paymentOrder.id,
        provider: "epay",
        providerPayload: { outTradeNo },
        expiresAt: checkoutExpiry,
      });
      return {
        url: checkout.url,
        params: checkout.params,
        method: "POST",
        orderId: paymentOrder.id,
      };
    } catch (error) {
      await dependencies.failCheckout({
        orderId: paymentOrder.id,
        provider: "epay",
      });
      throw error;
    }
  }

  const existingCheckoutUrl = dependencies.getCheckoutUrl(
    paymentOrder.providerPayload
  );
  if (existingCheckoutUrl) {
    return { url: existingCheckoutUrl, orderId: paymentOrder.id };
  }

  try {
    const checkout = await dependencies.createCreemCheckout({
      product_id: dependencies.getPackageCreemProductId(pkg),
      success_url: resultUrl,
      request_id: `credit_purchase_${paymentOrder.id}`,
      metadata: {
        userId: input.userId,
        type: "credit_purchase",
        paymentOrderId: paymentOrder.id,
        credits: String(creditsAmount),
        packageId: pkg.id,
        quantity: String(quantity),
        unitPrice: String(unitPrice),
        currency,
      },
    });
    await dependencies.saveCheckout({
      orderId: paymentOrder.id,
      provider: "creem",
      providerPayload: {
        checkoutId: checkout.id,
        checkoutUrl: checkout.checkout_url,
      },
      expiresAt: checkoutExpiry,
    });
    return { url: checkout.checkout_url, orderId: paymentOrder.id };
  } catch (error) {
    await dependencies.failCheckout({
      orderId: paymentOrder.id,
      provider: "creem",
    });
    throw error;
  }
}
