/**
 * 积分包购买 Checkout 的生产依赖适配器。
 *
 * 使用方：credits.createPurchaseCheckout UOL operation。把共享领域服务连接到
 * 系统配置、payment_order 仓储、易支付与 Creem SDK；本文件不处理传输鉴权。
 */

import { getBaseUrl } from "../config/payment";
import { logEvent } from "../logger/index";
import { assertRuntimeCreemCheckoutConfigured, creem } from "../payment/creem";
import {
  createRuntimeEpayPurchase,
  getRuntimePaymentProvider,
  saveEpayOrder,
} from "../payment/epay";
import { getRuntimeSettingNumber } from "../system-settings";
import { CREDIT_CONFIG_DEFAULTS, isCreditPackageVisible } from "./config";
import {
  getCreditPackageCreemProductId,
  getCreditPackageCurrency,
  getCreditPackagePrice,
  getRuntimeCreditPackageById,
} from "./packages";
import {
  type CreditPackagePurchaseCheckoutInput,
  type CreditPackagePurchaseCheckoutOutput,
  createCreditPackagePurchaseCheckout,
} from "./purchase-checkout-service";
import {
  createCreditPackagePaymentOrder,
  failCreditPackageCheckout,
  getCreditPackageCheckoutUrl,
  saveCreditPackageCheckout,
  saveCreditPackageProviderReference,
} from "./purchase-orders";
import { getCurrencyMinorUnitExponent } from "./top-up";

/**
 * 使用生产配置、数据库仓储与支付 SDK 创建积分包 Checkout。
 *
 * @param input - 已含 Principal 用户 ID 的传输无关下单输入。
 * @returns 本地订单与支付跳转信息。
 * @throws 领域校验、数据库或第三方支付错误，由 UOL operation 统一映射。
 * @sideeffect 写入支付订单和生命周期事件，并可能外呼支付供应商。
 */
export async function createRuntimeCreditPackagePurchaseCheckout(
  input: CreditPackagePurchaseCheckoutInput
): Promise<CreditPackagePurchaseCheckoutOutput> {
  return createCreditPackagePurchaseCheckout(input, {
    getPackageById: (packageId) =>
      getRuntimeCreditPackageById(packageId, { includeHidden: true }),
    isPackageVisible: (pkg) => isCreditPackageVisible(pkg),
    getPackagePrice: (pkg) => getCreditPackagePrice(pkg),
    getPackageCurrency: (pkg) => getCreditPackageCurrency(pkg),
    getPackageCreemProductId: (pkg) => getCreditPackageCreemProductId(pkg),
    getPaymentProvider: getRuntimePaymentProvider,
    assertCreemConfigured: assertRuntimeCreemCheckoutConfigured,
    getBaseUrl,
    getCreditsExpiryDays: () =>
      getRuntimeSettingNumber(
        "CREDITS_EXPIRY_DAYS",
        CREDIT_CONFIG_DEFAULTS.creditsExpiryDays,
        { nonNegative: true }
      ),
    getCurrencyMinorUnitExponent,
    createPaymentOrder: createCreditPackagePaymentOrder,
    saveEpayOrder,
    saveProviderReference: async (referenceInput) => {
      await saveCreditPackageProviderReference(referenceInput);
    },
    createEpayPurchase: createRuntimeEpayPurchase,
    createCreemCheckout: (checkoutInput) => creem.createCheckout(checkoutInput),
    saveCheckout: async (checkoutInput) => {
      await saveCreditPackageCheckout(checkoutInput);
    },
    failCheckout: async (failureInput) => {
      await failCreditPackageCheckout(failureInput);
    },
    getCheckoutUrl: getCreditPackageCheckoutUrl,
    logCheckoutStarted: (event) => {
      logEvent("payment.checkout.started", {
        ...event,
        checkoutType: "credits",
      });
    },
    now: () => new Date(),
  });
}
