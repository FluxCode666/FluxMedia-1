/**
 * 积分系统配置
 *
 * 定义积分系统的常量和一次性积分包配置
 */

// ============================================
// 积分配置常量
// ============================================

/**
 * 注册奖励积分数量
 */
export const REGISTRATION_BONUS_CREDITS = 100;

/**
 * 一次性购买积分默认过期天数（从发放日起）。
 * 0 表示永不过期。
 * 免费积分默认 7 天过期。
 * 历史订阅积分的过期时间仅由兼容履约数据传入，不产生新的订阅发放。
 */
export const CREDITS_EXPIRY_DAYS = 0;
export const FREE_CREDITS_EXPIRY_DAYS = 7;

export const CREDIT_CONFIG_DEFAULTS = {
  registrationBonusCredits: REGISTRATION_BONUS_CREDITS,
  creditsExpiryDays: CREDITS_EXPIRY_DAYS,
  freeCreditsExpiryDays: FREE_CREDITS_EXPIRY_DAYS,
} as const;

export const PAY_AS_YOU_GO_PACKAGE_ID = "payg_starter";
/** 历史资源包 ID；仅用于旧订单履约与流水展示兼容。 */
export const ENTERPRISE_RESOURCE_PACKAGE_ID = "enterprise_resource";
export const ENTERPRISE_RESOURCE_PACKAGE_DEFAULT_CREDITS = 5000;
export const ENTERPRISE_RESOURCE_PACKAGE_DEFAULT_PRICE = 15;

/**
 * 积分包配置（一次性购买）。
 *
 * price 是服务端唯一价格。Creem 一次性产品价格在 Creem 后台预建；currency
 * 按 ISO 4217 指定结账币种（缺省 CNY）；
 * Epay 仅支持 CNY，Creem 可按对应预建产品使用其他币种。
 */
export type CreditPackageConfig = {
  id: string;
  name: string;
  credits: number;
  price: number;
  currency?: string;
  description: string;
  popular?: boolean;
  visible?: boolean;
  allowQuantity?: boolean;
  maxQuantity?: number;
  creemProductId?: string;
};

/**
 * 默认积分包。旧积分包保留为隐藏项，用于兼容可能已创建但尚未回调的历史订单。
 */
export const CREDIT_PACKAGES = [
  {
    id: PAY_AS_YOU_GO_PACKAGE_ID,
    name: "Pay as you go",
    credits: 5000,
    price: 20,
    currency: "CNY",
    popular: true,
    description: "One-time pay-as-you-go credits",
  },
  {
    id: ENTERPRISE_RESOURCE_PACKAGE_ID,
    name: "Resource Pack",
    credits: ENTERPRISE_RESOURCE_PACKAGE_DEFAULT_CREDITS,
    price: ENTERPRISE_RESOURCE_PACKAGE_DEFAULT_PRICE,
    currency: "CNY",
    description: "One-time 5,000-credit resource pack",
    allowQuantity: true,
    maxQuantity: 999,
    visible: false,
  },
  {
    id: "lite",
    name: "Lite",
    credits: 100,
    price: 5,
    currency: "CNY",
    description: "Quick top-up for a few images",
    visible: false,
  },
  {
    id: "standard",
    name: "Standard",
    credits: 500,
    price: 20,
    currency: "CNY",
    description: "Best value for regular use",
    visible: false,
  },
  {
    id: "pro",
    name: "Pro",
    credits: 1000,
    price: 35,
    currency: "CNY",
    description: "Maximum credits, maximum savings",
    visible: false,
  },
] as const satisfies readonly CreditPackageConfig[];

/**
 * 积分包类型
 */
export type CreditPackage = CreditPackageConfig;

/**
 * 积分包 ID 类型
 */
export type CreditPackageId = string;

export function isCreditPackageVisible(pkg: { id: string; visible?: boolean }) {
  return !("visible" in pkg) || pkg.visible !== false;
}
